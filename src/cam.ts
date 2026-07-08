// SOURCE-MIRROR: ippoan/rust-flickr:src/cam.rs (2026-07-08 TypeScript 移植、
// 経由: ohishi-exp/ohishi-logi:src/cam.rs)
//
// カメラ (SD カード CGI) クライアント。カメラは Cloudflare Tunnel 越しの private
// network 上にあり、Workers VPC Services (`env.CAM_SERVICE` binding) 経由で
// 到達する — 公開 URL (旧 cloudflared 公開ルート) は使わない
// (Refs ohishi-exp/ohishi-logi#1 2026-07-08 方針転換、
// https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/)。
//
// Digest 認証 (RFC 2617 / MD5) は Web Crypto API が MD5 を持たないため
// `./md5.ts` の pure-JS 実装を使う。SD カードの一覧は XML で返る:
// ディレクトリは `<Dir name="20250323"/>`、ファイルは
// `<Name>Event20250323_005902.jpg</Name>`。`_!` を含むファイル名はカメラの
// 一時ファイルなので除外する。
//
// ohishi-logi (Cloud Run) は本移植により不要になった (Refs ohishi-exp/ohishi-logi#1)。

import { md5Hex } from "./md5";

export class CamUpstreamError extends Error {}

export interface CamConfig {
  digestUser: string;
  digestPass: string;
  machineName: string;
  sdcardCgi: string;
  mp4Cgi: string;
  jpgCgi: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
}

const EVENT_DIR = "/Event";

export class CamClient {
  private readonly config: CamConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: CamConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  get machineName(): string {
    return this.config.machineName;
  }

  private camHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.config.cfAccessClientId) headers["CF-Access-Client-Id"] = this.config.cfAccessClientId;
    if (this.config.cfAccessClientSecret) {
      headers["CF-Access-Client-Secret"] = this.config.cfAccessClientSecret;
    }
    return headers;
  }

  /** CF Access ヘッダ + (401 なら) Digest 認証リトライ付き GET */
  private async fetchCam(url: string): Promise<Response> {
    const response = await this.fetchImpl(url, { headers: this.camHeaders() });
    if (response.status === 401) {
      const wwwAuth = response.headers.get("www-authenticate") ?? "";
      if (wwwAuth.includes("Digest")) {
        const auth = digestAuthHeader(this.config.digestUser, this.config.digestPass, "GET", url, wwwAuth);
        return this.fetchImpl(url, { headers: this.camHeaders({ Authorization: auth }) });
      }
    }
    return response;
  }

  private async fetchXml(url: string): Promise<string> {
    const response = await this.fetchCam(url);
    const body = await response.text().catch(() => "");
    if (!response.ok) {
      throw new CamUpstreamError(`camera listing failed for ${url}: ${response.status}`);
    }
    return body;
  }

  /** SD カードの日付ディレクトリ一覧 (YYYYMMDD) */
  async listDates(): Promise<string[]> {
    const url = `${this.config.sdcardCgi}${this.config.machineName}${EVENT_DIR}`;
    return parseDirNames(await this.fetchXml(url));
  }

  /** デバッグ用: SD カードルート一覧の生レスポンス (status/body) をそのまま返す。
   * `listDates()` が 0 件を返した時、カメラ側が本当に空応答なのか
   * `parseDirNames` が想定外のフォーマットを黙って 0 件にパースしているのかを
   * 切り分けるために使う (Refs #19)。 */
  async debugListRoot(): Promise<{ url: string; status: number; body: string }> {
    const url = `${this.config.sdcardCgi}${this.config.machineName}${EVENT_DIR}`;
    const response = await this.fetchCam(url);
    const body = await response.text().catch(() => "");
    return { url, status: response.status, body };
  }

  /** 指定日付の時間ディレクトリ一覧 */
  async listHours(date: string): Promise<string[]> {
    const url = `${this.config.sdcardCgi}${this.config.machineName}${EVENT_DIR}/${date}`;
    return parseDirNames(await this.fetchXml(url));
  }

  /** 指定 (日付, 時間) のファイル名一覧 */
  async listFileNames(date: string, hour: string): Promise<string[]> {
    const url = `${this.config.sdcardCgi}${this.config.machineName}${EVENT_DIR}/${date}/${hour}`;
    return parseFileNames(await this.fetchXml(url));
  }

  /** ファイル本体をダウンロード (mp4 / jpg で CGI を出し分け) */
  async download(name: string, date: string, hour: string): Promise<Uint8Array> {
    const base = name.includes(".mp4") ? this.config.mp4Cgi : this.config.jpgCgi;
    const url = `${base}${this.config.machineName}${EVENT_DIR}/${date}/${hour}/${name}`;
    const response = await this.fetchCam(url);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType !== "application/octet-stream") {
      throw new CamUpstreamError(`unexpected content type for ${name}: ${contentType}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}

// ---- Digest 認証 (RFC 2617 / MD5) ----

/** www-authenticate ヘッダから Digest Authorization ヘッダ値を生成。
 * uri には rust-flickr / ohishi-logi との互換で **full URL** を渡す
 * (RFC 的には request-path だがカメラ側はこれを受ける実績がある)。 */
function digestAuthHeader(username: string, password: string, method: string, uri: string, wwwAuth: string): string {
  const params: Record<string, string> = {};
  for (const part of wwwAuth.split(",")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    let key = trimmed.slice(0, eq).trim();
    if (key.startsWith("Digest ")) key = key.slice("Digest ".length);
    const value = trimmed.slice(eq + 1).trim().replace(/^"|"$/g, "");
    params[key] = value;
  }
  const realm = params["realm"] ?? "";
  const nonce = params["nonce"] ?? "";
  const qop = params["qop"];

  const nc = "00000001";
  const cnonceFull = crypto.randomUUID().replace(/-/g, "");
  const cnonce = cnonceFull.slice(0, 13);

  const response = digestResponse(username, password, method, uri, realm, nonce, qop, nc, cnonce);

  let header = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  if (qop !== undefined) {
    header += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  }
  return header;
}

/** Digest response 値 (MD5)。既知ベクタでテストできるよう cnonce 等を引数で受ける。
 * export はテスト専用 (RFC 2617 §3.5 既知ベクタのピン)。 */
export function digestResponse(
  username: string,
  password: string,
  method: string,
  uri: string,
  realm: string,
  nonce: string,
  qop: string | undefined,
  nc: string,
  cnonce: string,
): string {
  const ha1 = md5Hex(`${username}:${realm}:${password}`);
  const ha2 = md5Hex(`${method}:${uri}`);
  if (qop !== undefined) {
    return md5Hex(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  }
  return md5Hex(`${ha1}:${nonce}:${ha2}`);
}

// ---- カメラ XML パース ----
//
// カメラの応答 XML は `<Dir name="...">` / `<Name>...</Name>` の固定形状のみ
// (Flickr upload 応答 XML と同様) なので、フル XML パーサーではなく正規表現で
// 十分 — 依存を増やさない (「薄く保つ」方針)。

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** `<Dir name="20250323"/>` の name 属性を抽出 (要素名・属性名の大文字小文字は不問) */
export function parseDirNames(xmlText: string): string[] {
  const dirs: string[] = [];
  const tagRe = /<Dir\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xmlText)) !== null) {
    const nameMatch = /\bname\s*=\s*"([^"]*)"/i.exec(m[1]);
    if (nameMatch) dirs.push(nameMatch[1]);
  }
  return dirs;
}

/** `<Name>Event20250323_005902.jpg</Name>` のテキストを抽出。
 * `_!` を含むファイル名 (カメラの一時ファイル) はスキップ */
export function parseFileNames(xmlText: string): string[] {
  const files: string[] = [];
  const tagRe = /<Name(?:\s[^>]*)?>([\s\S]*?)<\/Name>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xmlText)) !== null) {
    const filename = decodeXmlEntities(m[1]);
    if (!filename.includes("_!")) files.push(filename);
  }
  return files;
}
