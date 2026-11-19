/**
 * EasyIQ SkolePortal (widget `0128`).
 *
 * NOTE: this is a *different* product from the existing EasyIQ Ugeplan
 * widget (`0001` → EasyIqClient). Same vendor, distinct SaaS backend
 * (`skoleportal.easyiqcloud.dk` vs `api.easyiqcloud.dk`), different auth
 * flow, different (PascalCase) event JSON.
 *
 * Bake-in for upstream PR scaarup/aula#352 ("Add EasyIQ SkolePortal support").
 *
 * Flow per call:
 *   1. Get a widget token for 0128 (via WidgetTokenManager).
 *   2. POST /Aula/AuthenticateAulaUser per-child with x-childfilter +
 *      x-institutionfilter + x-login headers; receive `{ loginId, ... }`.
 *   3. GET /Calendar/CalendarGetWeekplanEvents?loginId=…&date=YYYY-MM-DD;
 *      receive an array of events with PascalCase fields.
 *
 * Multi-child: the PR iterates per child because each child's loginId is
 * tied to that child's filters. We do the same.
 *
 * When a child's school has no SkolePortal licence, AuthenticateAulaUser
 * doesn't fail — it answers for a sibling instead (`child` is the sibling's
 * userId). Using that loginId would file the sibling's week plan under the
 * wrong child, so a mismatched `child` becomes a per-child warning
 * (upstream scaarup/aula d8f5595).
 */

import type { AulaHttpClient } from '@aula-mcp/aula-auth';
import type { WidgetTokenManager } from '../widget-token-manager.ts';
import { isWidgetTokenExpiredResponse } from '../widget-token-manager.ts';
import {
  decodeHtmlEntities,
  htmlToText,
  type IntegrationContext,
  isoDate,
  isoWeekToMonday,
  type NormalisedWeekPlan,
  type NormalisedWeekPlanItem,
} from './types.ts';

const SP_BASE = 'https://skoleportal.easyiqcloud.dk';
const SP_AUTH_URL = `${SP_BASE}/Aula/AuthenticateAulaUser`;
const SP_WEEKPLAN_URL = `${SP_BASE}/Calendar/CalendarGetWeekplanEvents`;
// "Generelt om ugen" — the teachers' weekly letter. A separate endpoint from
// the calendar events, and the part families actually read. scaarup/aula
// fetches it in client.py (`parse_easyiq_weekly_letter`); the MCP did not.
const SP_WEEK_LETTER_URL = `${SP_BASE}/Calendar/WeekPlan`;
const SP_WIDGET_ID = '0128';
// Match PR #352's UA — SkolePortal's edge tier 302s requests it doesn't
// recognise as a desktop browser, regardless of the auth header.
const SP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

interface SpAuthResponse {
  loginId?: string;
  /** userId of the child the response is for — not always the one asked about. */
  child?: string | number;
  childName?: string;
  schoolName?: string;
  schoolId?: string | number;
}

interface SpEvent {
  StartTime?: string;
  StartTimeISO?: string;
  EndTime?: string;
  CoursesDisplay?: string;
  ActivitiesDisplay?: string;
  ChapterTitle?: string;
  Description?: string;
}

interface SpWeekPlanLetter {
  Text?: string;
  IsVisible?: boolean | string;
  Beskrivelse?: string;
  WeekPlans?: SpWeekPlanLetter[];
}

/**
 * Extract "Generelt om ugen" from `/Calendar/WeekPlan`.
 *
 * Payload shape (mirrors scaarup/aula's `parse_easyiq_weekly_letter`):
 *   {Show, Text, IsVisible, Beskrivelse, WeekPlans: [{ActivityName, Text,
 *    IsVisible, Beskrivelse}, …]}
 * `Text` is HTML; only visible, non-empty entries count. Returns plain text
 * (markup stripped, entities decoded) or null when there is no letter.
 */
function parseWeeklyLetter(body: string): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;

  const isVisible = (v: unknown): boolean => {
    if (typeof v === 'string') return !['false', '0', 'no'].includes(v.trim().toLowerCase());
    return v !== false;
  };

  const parts: string[] = [];
  const add = (item: unknown): void => {
    if (typeof item !== 'object' || item === null) return;
    const rec = item as SpWeekPlanLetter;
    if (!isVisible(rec.IsVisible)) return;
    const text = typeof rec.Text === 'string' ? rec.Text.trim() : '';
    if (text) parts.push(text);
  };

  add(payload);
  const plans = (payload as SpWeekPlanLetter).WeekPlans;
  if (Array.isArray(plans)) for (const p of plans) add(p);

  const text = parts.map((p) => htmlToText(p)).filter(Boolean).join('\n\n');
  return text || null;
}

export interface EasyIqSkoleportalOptions {
  http: AulaHttpClient;
  widgets: WidgetTokenManager;
  widgetId?: string;
}

export class EasyIqSkoleportalClient {
  static readonly id = 'easyiq_skoleportal' as const;
  static readonly capabilities = ['ugeplan'] as const;

  private readonly http: AulaHttpClient;
  private readonly widgets: WidgetTokenManager;
  private readonly widgetId: string;

  constructor(opts: EasyIqSkoleportalOptions) {
    this.http = opts.http;
    this.widgets = opts.widgets;
    this.widgetId = opts.widgetId ?? SP_WIDGET_ID;
  }

  async getWeekPlan(ctx: IntegrationContext): Promise<NormalisedWeekPlan> {
    const monday = isoWeekToMonday(ctx.isoWeek);
    // SkolePortal expects the date as `YYYY-MM-DDT00:00:00.000Z`, NOT plain
    // `YYYY-MM-DD`. The plain form silently returns no events.
    const dateParam = `${isoDate(monday)}T00:00:00.000Z`;
    // The weekly-letter endpoint takes the same Monday but the plain
    // `YYYY-MM-DDT00:00:00` form (scaarup/aula's `target_date`).
    const letterDateParam = `${isoDate(monday)}T00:00:00`;
    const items: NormalisedWeekPlanItem[] = [];
    const warnings: string[] = [];
    const rawByChild: Record<string, unknown> = {};

    for (let i = 0; i < ctx.childIds.length; i++) {
      const childId = ctx.childIds[i];
      const childUserId = ctx.childUserIds?.[i];
      if (childId === undefined) continue;
      try {
        if (!childUserId) {
          throw new Error(
            'SkolePortal needs the per-child userId (opaque alphanumeric token); none was provided',
          );
        }
        const childResult = await this.fetchOneChild(ctx, childUserId, dateParam, letterDateParam);
        rawByChild[String(childId)] = childResult.raw;
        for (const item of childResult.items) items.push(item);
        for (const w of childResult.warnings) warnings.push(`child ${childId}: ${w}`);
      } catch (e) {
        warnings.push(`child ${childId}: ${(e as Error).message}`);
      }
    }

    return { items, raw: rawByChild, ...(warnings.length ? { warnings } : {}) };
  }

  private async fetchOneChild(
    ctx: IntegrationContext,
    childUserId: string,
    dateParam: string,
    letterDateParam: string,
  ): Promise<{
    items: NormalisedWeekPlanItem[];
    raw: { auth: SpAuthResponse; events: SpEvent[]; letter: string | null };
    warnings: string[];
  }> {
    const auth = await this.authenticate(ctx, childUserId);
    if (auth.child != null && String(auth.child).toLowerCase() !== childUserId.toLowerCase()) {
      throw new Error(
        'SkolePortal is not available for this child (the response was for a different child)',
      );
    }
    if (!auth.loginId) {
      throw new Error('SkolePortal authentication response missing loginId');
    }
    const events = await this.fetchEvents(ctx, childUserId, auth.loginId, dateParam);
    // The letter is supplementary: a failure here must never cost us the
    // calendar events, so it degrades to a warning instead of an exception.
    const warnings: string[] = [];
    let letter: string | null = null;
    try {
      letter = await this.fetchWeeklyLetter(ctx, childUserId, auth.loginId, letterDateParam);
    } catch (e) {
      warnings.push(`weekly letter unavailable: ${(e as Error).message}`);
    }
    const childName = decodeHtmlEntities(auth.childName ?? '');
    const items: NormalisedWeekPlanItem[] = [];
    if (letter) {
      items.push({
        kind: 'letter',
        title: 'Generelt om ugen',
        content: letter,
        ...(childName ? { childName } : {}),
      });
    }
    for (const ev of events) {
      const item: NormalisedWeekPlanItem = { kind: 'event' };
      if (childName) item.childName = childName;
      const dateStr = ev.StartTimeISO ?? ev.StartTime;
      if (dateStr) item.date = dateStr;
      const subject = decodeHtmlEntities(ev.CoursesDisplay ?? '');
      const cls = decodeHtmlEntities(ev.ActivitiesDisplay ?? '');
      if (subject || cls) item.subject = [subject, cls].filter(Boolean).join(' / ');
      const title = decodeHtmlEntities(ev.ChapterTitle ?? '');
      if (title) item.title = title;
      const desc = decodeHtmlEntities(ev.Description ?? '');
      if (desc) item.content = desc;
      items.push(item);
    }
    return { items, raw: { auth, events, letter }, warnings };
  }

  /**
   * Header set per upstream PR scaarup/aula#352. Bugs we got wrong before:
   *   • `authorization` needs the literal `Bearer ` prefix. PR #352 looks
   *     like `authorization: token`, but their `get_token` helper stores
   *     `"Bearer " + jwt`, so the on-the-wire header still has the prefix.
   *     Ours stores the raw JWT, so we have to prepend it ourselves.
   *   • origin/referer point at `skoleportal.easyiqcloud.dk`, not aula.dk —
   *     SkolePortal's CORS-ish guard rejects the wrong origin with a
   *     302→/Login that masquerades as an auth failure.
   *   • A desktop user-agent + `x-requested-with: XMLHttpRequest`. The edge
   *     tier rate-limits / bounces requests that look like bots.
   *   • `x-childfilter` is the per-child opaque userId token, NOT the
   *     numeric Aula child id.
   */
  private spHeaders(
    token: string,
    childUserId: string,
    institutions: string,
    login: string,
  ): Record<string, string> {
    return {
      accept: '*/*',
      'accept-language': 'en-US,en;q=0.9,da;q=0.8',
      authorization: `Bearer ${token}`,
      origin: SP_BASE,
      referer: `${SP_BASE}/UgeplanWidget`,
      'user-agent': SP_USER_AGENT,
      'x-childfilter': childUserId,
      'x-institutionfilter': institutions,
      'x-login': login,
      'x-requested-with': 'XMLHttpRequest',
      'x-userprofile': 'guardian',
    };
  }

  private async authenticate(
    ctx: IntegrationContext,
    childUserId: string,
  ): Promise<SpAuthResponse> {
    return this.widgets.withRetry(this.widgetId, async (token) => {
      const headers = this.spHeaders(
        token,
        childUserId,
        ctx.institutionCodes.join(','),
        ctx.sessionId,
      );
      const res = await this.http.request(SP_AUTH_URL, { method: 'POST', headers });
      if (isWidgetTokenExpiredResponse(res.body, res.status)) {
        return { _expired: true as const, status: res.status, bodySnippet: res.body.slice(0, 200) };
      }
      if (res.status !== 200) {
        throw new Error(
          `SkolePortal AuthenticateAulaUser failed (status ${res.status}): ${res.body.slice(0, 200)}`,
        );
      }
      return JSON.parse(res.body) as SpAuthResponse;
    });
  }

  private async fetchEvents(
    ctx: IntegrationContext,
    childUserId: string,
    loginId: string,
    dateParam: string,
  ): Promise<SpEvent[]> {
    // Re-use the same widget token; calendar GET uses the same header set
    // (PR #352 reuses `headers` directly between auth and calendar calls).
    return this.widgets.withRetry(this.widgetId, async (token) => {
      const headers = this.spHeaders(
        token,
        childUserId,
        ctx.institutionCodes.join(','),
        ctx.sessionId,
      );
      const url = `${SP_WEEKPLAN_URL}?loginId=${encodeURIComponent(loginId)}&date=${encodeURIComponent(dateParam)}`;
      const res = await this.http.request(url, { method: 'GET', headers });
      if (isWidgetTokenExpiredResponse(res.body, res.status)) {
        return { _expired: true as const, status: res.status, bodySnippet: res.body.slice(0, 200) };
      }
      if (res.status !== 200) {
        throw new Error(
          `SkolePortal CalendarGetWeekplanEvents failed (status ${res.status}): ${res.body.slice(0, 200)}`,
        );
      }
      const parsed = JSON.parse(res.body) as unknown;
      return Array.isArray(parsed) ? (parsed as SpEvent[]) : [];
    });
  }

  /**
   * "Generelt om ugen" — the teachers' weekly letter. Same header set as the
   * calendar call; `activityFilter` is sent empty, as scaarup/aula does.
   * Returns null when the school publishes no letter that week.
   */
  private async fetchWeeklyLetter(
    ctx: IntegrationContext,
    childUserId: string,
    loginId: string,
    dateParam: string,
  ): Promise<string | null> {
    return this.widgets.withRetry(this.widgetId, async (token) => {
      const headers = this.spHeaders(
        token,
        childUserId,
        ctx.institutionCodes.join(','),
        ctx.sessionId,
      );
      const url =
        `${SP_WEEK_LETTER_URL}?loginId=${encodeURIComponent(loginId)}` +
        `&activityFilter=&date=${encodeURIComponent(dateParam)}`;
      const res = await this.http.request(url, { method: 'GET', headers });
      if (isWidgetTokenExpiredResponse(res.body, res.status)) {
        return { _expired: true as const, status: res.status, bodySnippet: res.body.slice(0, 200) };
      }
      if (res.status !== 200) {
        throw new Error(
          `SkolePortal WeekPlan failed (status ${res.status}): ${res.body.slice(0, 200)}`,
        );
      }
      return parseWeeklyLetter(res.body);
    });
  }
}
