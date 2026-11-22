import { DurableObject } from "cloudflare:workers";

const COOLDOWN_MS = 60_000;

/** One instance per Ads customer. The persisted reservation survives isolate
 * restarts, and the transaction prevents simultaneous misses from dispatching. */
export class GoogleAdsPlannerLimiter extends DurableObject<unknown> {
  async fetch(request: Request): Promise<Response> {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/reserve"
    ) {
      return new Response(null, { status: 404 });
    }
    const reserved = await this.ctx.storage.transaction(async (tx) => {
      const now = Date.now();
      const next = await tx.get<number>("next-allowed");
      if (next !== undefined && next > now) return false;
      await tx.put("next-allowed", now + COOLDOWN_MS);
      return true;
    });
    return new Response(null, { status: reserved ? 204 : 429 });
  }
}
