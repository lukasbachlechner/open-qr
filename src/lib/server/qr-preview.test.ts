import { beforeEach, describe, expect, it } from "vitest";
import type { RequestEvent } from "@sveltejs/kit";
import { POST } from "../../routes/api/v1/qr/+server";
import { PATCH } from "../../routes/api/v1/qr/[short_code]/+server";
import { GET as image } from "../../routes/api/v1/qr/[short_code]/image/+server";
import { db } from "$lib/db";
import { createQRCode, getQRCode, generateQRSVG } from "./qr";
import { setSetting } from "./settings";

let owner: { id: number; email: string; isAdmin: boolean };
let shortCode: string;
const style = { template: "default", errorCorrection: "M" };
function event<Route extends "/api/v1/qr" | "/api/v1/qr/[short_code]" | "/api/v1/qr/[short_code]/image">(
  body: unknown,
  user: typeof owner | null = owner,
): RequestEvent<{ short_code: string }, Route> {
  const url = new URL("https://qr.example.test/api/v1/qr?preview=1");
  return {
    url,
    params: { short_code: shortCode },
    locals: { user },
    request: new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  } as unknown as RequestEvent<{ short_code: string }, Route>;
}
async function preview(targetUrl: string) {
  const response = await POST(event({ targetUrl, existingShortCode: shortCode, style }));
  return (await response.json()).data;
}

beforeEach(() => {
  db.prepare("DELETE FROM qr_codes").run();
  db.prepare("DELETE FROM users").run();
  setSetting("PUBLIC_BASE_URL", "https://qr.example.test");
  const id = Number(db.prepare("INSERT INTO users (email) VALUES (?)").run("owner@example.test").lastInsertRowid);
  owner = { id, email: "owner@example.test", isAdmin: false };
  shortCode = createQRCode("https://example.com/original", id, style).shortCode;
});

describe("saved dynamic QR previews", () => {
  it("encodes the real redirect URL before and after a destination-only edit", async () => {
    const before = await preview("https://example.com/original");
    const edited = await preview("https://example.com/changed");
    expect(edited.shortUrl).toBe(`https://qr.example.test/go/${shortCode}`);
    expect(edited.svg).toBe(before.svg);
    expect(edited.dataUrl).toBe(before.dataUrl);
    expect(edited.svg).toBe(await generateQRSVG(edited.shortUrl, style));
    expect(getQRCode(shortCode).target_url).toBe("https://example.com/original");

    const saved = await PATCH(event({ target_url: "https://example.com/changed" }));
    const savedData = (await saved.json()).data;
    expect(savedData.svg).toBe(before.svg);
    expect(savedData.dataUrl).toBe(before.dataUrl);
    expect(getQRCode(shortCode).target_url).toBe("https://example.com/changed");

    const downloaded = await image({
      ...event<"/api/v1/qr/[short_code]/image">({}),
      url: new URL("https://qr.example.test/?format=svg"),
    });
    expect(await downloaded.text()).toBe(before.svg);
  });

  it("allows style previews without changing or persisting the destination", async () => {
    const response = await POST(
      event({
        targetUrl: "https://example.com/changed",
        existingShortCode: shortCode,
        style: { foregroundColor: "#123456" },
      }),
    );
    const data = (await response.json()).data;
    expect(data.svg).toContain("#123456");
    expect(data.shortUrl).toBe(`https://qr.example.test/go/${shortCode}`);
    expect(getQRCode(shortCode).foreground_color).not.toBe("#123456");
  });

  it("requires authentication and ownership or administrator access", async () => {
    const body = { targetUrl: "https://example.com/changed", existingShortCode: shortCode };
    await expect(POST(event(body, null))).rejects.toMatchObject({ status: 401 });
    const other = { id: owner.id + 1, email: "other@example.test", isAdmin: false };
    await expect(POST(event(body, other))).rejects.toMatchObject({ status: 403 });
    other.isAdmin = true;
    expect((await POST(event(body, other))).status).toBe(200);
  });

  it("rejects missing saved codes and malformed references", async () => {
    await expect(POST(event({ targetUrl: "https://example.com", existingShortCode: "missing" }))).rejects.toMatchObject(
      { status: 404 },
    );
    await expect(POST(event({ targetUrl: "https://example.com", existingShortCode: 42 }))).rejects.toMatchObject({
      status: 400,
    });
  });

  it("keeps new-code and static previews working without creating records", async () => {
    const fresh = await POST(event({ targetUrl: "https://example.com/new" }, null));
    const freshData = (await fresh.json()).data;
    expect(freshData.shortUrl).toBe("");
    expect(freshData.svg).toBe(await generateQRSVG("https://qr.example.test/go/PREVIEW1"));
    const staticResponse = await POST(event({ kind: "text", payload: { text: "Sample text" } }, null));
    const staticData = (await staticResponse.json()).data;
    expect(staticData.svg).toBe(await generateQRSVG("Sample text", {}, { raw: true }));
    expect(db.prepare("SELECT COUNT(*) AS count FROM qr_codes").get()).toEqual({ count: 1 });
  });
});
