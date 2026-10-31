// Test helpers: load the worker as an ES module, fake KV, the InPlayFlux feed and Telegram.
// Run all tests with `node --test "worker/test/*.test.mjs"` (no npm install needed).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");

// index.js is an ES module without a package.json "type", so import a copy with an .mjs name.
export async function loadWorker() {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mb-worker-")), "index.mjs");
  fs.copyFileSync(SRC, tmp);
  return (await import(pathToFileURL(tmp).href)).default;
}

export function makeKV() {
  const store = new Map();
  const meta = new Map();
  return {
    store, meta,
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v, o = {}) => { store.set(k, v); if (o.metadata) meta.set(k, o.metadata); },
    delete: async (k) => { store.delete(k); meta.delete(k); },
    list: async ({ prefix } = {}) => ({
      keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix))
        .map((name) => ({ name, metadata: meta.get(name), expiration: 9999999999 })),
      list_complete: true,
    }),
  };
}

// Fakes global fetch: the feed returns `state.feed` (undefined = feed down), Telegram calls are recorded.
export function mockNet(state) {
  state.sent = state.sent || [];
  let nextId = 100;
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    if (url.includes("ir_token_refresh")) return new Response(null, { status: 200, headers: { "X-IR-Token": "a".repeat(64), "Set-Cookie": "s=1; path=/" } });
    if (url.includes("GETAllMatches")) return state.feed === undefined ? new Response("err", { status: 500 }) : new Response(JSON.stringify(state.feed));
    if (url.includes("api.telegram.org")) {
      const body = opts.body instanceof FormData ? Object.fromEntries(opts.body.entries()) : JSON.parse(opts.body);
      const method = url.split("/").pop();
      state.sent.push({ method, ...body });
      if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { username: "MoneyBagTestBot" } }));
      if (method === "createChatInviteLink") return new Response(JSON.stringify({ ok: true, result: { invite_link: "https://t.me/+trial" + nextId++ } }));
      if (method === "banChatMember" || method === "unbanChatMember") return new Response(JSON.stringify({ ok: true, result: true }));
      return new Response(JSON.stringify({ ok: true, result: { message_id: nextId++ } }));
    }
    throw new Error("unexpected fetch " + url);
  };
  return state;
}

export function makeEnv(extra = {}) {
  return {
    ACCESS_KV: makeKV(), TELEGRAM_BOT_TOKEN: "x", PREMIUM_CHANNEL_ID: "-100", TELEGRAM_WEBHOOK_SECRET: "s",
    ADMIN_PASSWORD: "pw", ADMIN_CHAT_ID: "777", ASSETS: { fetch: () => new Response("asset") }, ...extra,
  };
}

export const webhook = (worker, env, text) => worker.fetch(new Request("https://x/telegram-webhook", {
  method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "s" }, body: JSON.stringify({ channel_post: { text } }),
}), env, { waitUntil: () => {} });

export async function cron(worker, env, expr = "* * * * *") {
  const jobs = [];
  await worker.scheduled({ cron: expr }, env, { waitUntil: (p) => jobs.push(p) });
  await Promise.all(jobs);
}

export const admin = (worker, env, p, init = {}) => worker.fetch(new Request("https://x" + p, {
  ...init, headers: { Authorization: "Bearer pw", ...(init.headers || {}) },
}), env, { waitUntil: () => {} });

// An InPlayFlux card in the real format (since 31.10. with the 📉/📈 trend arrow, which the parser had missed).
export function card({ header = "💰 MoneyBag 2-0/0-2 → Over 2.5 New", home = "Alpha FC", away = "Beta FC", score = "2-0",
  target = "Over 2.5 Goals", league = "Liga", minute = 56, sot = [6, 4], radar = 450, pre = "4.0", live = "3.5", over = "1.95", under = "1.85", trend = "📉" } = {}) {
  return `${header}\n🏆 ${league}\n⚽ ${home} ${score} ${away}\n🎯 Target: ${target}\n⏱ ${minute}' · ~30 min left\n` +
    `📊 Shots ${sot[0]} · ${sot[1]} / 10 · 8 total\n📡 Radar X: x (${radar})\n⚖️ O/U  ${pre} → ${live} ${trend}   Over ${over}  Under ${under}`; // real cards: 📉/📈 before the odds
}

export const tracked = (env) => JSON.parse(env.ACCESS_KV.store.get("track:open") || "[]");
export const results = (env) => [...env.ACCESS_KV.meta.values()].filter((r) => r && r.result);
