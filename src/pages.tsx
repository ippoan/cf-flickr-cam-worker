// OAuth 認可/状況確認・画像確認用の簡易 HTML ページ (Hono JSX)。
// API (JSON) 応答とは別に、人間がブラウザで操作するための最小限の UI。

import type { FC } from "hono/jsx";

import type { CamFileRow, DayStats } from "./d1";

const Layout: FC<{ title: string; prefix: string; children?: unknown }> = ({ title, prefix, children }) => (
  <html lang="ja">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <style>{`
        body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
        h1 { font-size: 1.25rem; }
        table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
        th, td { text-align: left; padding: 0.35rem 0.6rem; border-bottom: 1px solid #ddd; font-size: 0.9rem; }
        .badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.75rem; }
        .badge-ok { background: #dcfce7; color: #166534; }
        .badge-pending { background: #fef9c3; color: #854d0e; }
        .badge-zombie { background: #e5e7eb; color: #4b5563; }
        .button { display: inline-block; background: #0ea5e9; color: #fff; padding: 0.5rem 1rem; border-radius: 0.4rem; text-decoration: none; border: none; font-size: 1rem; cursor: pointer; }
        nav a { margin-right: 1rem; }
        .thumb { max-width: 160px; height: auto; border-radius: 4px; display: block; transition: transform 0.15s; }
        .thumb-cell { width: 170px; }
        .thumb-box { display: grid; place-items: center; }
        [data-rot=r90] .thumb-box, [data-rot=r270] .thumb-box { height: 160px; }
        [data-rot=r90] .thumb, #viewer[data-rot=r90] img { transform: rotate(90deg); }
        [data-rot=r180] .thumb, #viewer[data-rot=r180] img { transform: rotate(180deg); }
        [data-rot=r270] .thumb, #viewer[data-rot=r270] img { transform: rotate(270deg); }
        .toolbar { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
        .hint { color: #6b7280; font-size: 0.8rem; }
        #viewer { position: fixed; inset: 0; background: rgba(0,0,0,0.92); display: none; place-items: center; z-index: 10; }
        #viewer.open { display: grid; }
        #viewer img { max-width: 96vw; max-height: 86vh; transition: transform 0.15s; }
        #viewer[data-rot=r90] img, #viewer[data-rot=r270] img { max-width: 86vh; max-height: 96vw; }
        #viewer .bar { position: fixed; top: 0; left: 0; right: 0; display: flex; gap: 0.5rem; align-items: center; justify-content: space-between; padding: 0.5rem 1rem; color: #fff; font-size: 0.9rem; }
        #viewer button { background: rgba(255,255,255,0.15); color: #fff; border: none; border-radius: 0.4rem; padding: 0.4rem 0.8rem; font-size: 1rem; cursor: pointer; }
        #viewer .nav { position: fixed; top: 50%; transform: translateY(-50%); font-size: 2rem; padding: 0.5rem 0.9rem; }
        #viewer .prev { left: 0.5rem; }
        #viewer .next { right: 0.5rem; }
      `}</style>
    </head>
    <body>
      <nav>
        <a href={`${prefix}/`}>状況</a>
        <a href={`${prefix}/images`}>画像確認</a>
      </nav>
      <h1>{title}</h1>
      {children}
    </body>
  </html>
);

export const StatusPage: FC<{
  authorized: boolean;
  username: string | null;
  days: DayStats[];
  prefix: string;
  deployedAt: string;
  version: string;
}> = ({ authorized, username, days, prefix, deployedAt, version }) => (
  <Layout title="cf-flickr-cam-worker" prefix={prefix}>
    <p style="color:#6b7280; font-size:0.8rem; margin-top:-0.5rem;">
      deploy: {deployedAt} (version {version})
    </p>
    {authorized ? (
      <p>
        Flickr に接続済み: <strong>{username}</strong>
      </p>
    ) : (
      <p>
        Flickr 未接続です。
        <a class="button" href={`${prefix}/oauth/start`}>
          Flickr に接続
        </a>
      </p>
    )}
    <form method="post" action={`${prefix}/admin/sync`} onsubmit="return confirm('今すぐカメラの取り込みを実行しますか?');">
      <button class="button" type="submit">
        今すぐ同期を実行
      </button>
    </form>
    <h2>直近の同期状況</h2>
    {days.length === 0 ? (
      <p>まだ同期データがありません。</p>
    ) : (
      <table>
        <thead>
          <tr>
            <th>日付</th>
            <th>件数</th>
            <th>アップロード済</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr>
              <td>
                <a href={`${prefix}/images?date=${d.date}`}>{d.date}</a>
              </td>
              <td>{d.files}</td>
              <td>{d.uploaded}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </Layout>
);

/** OAuth 完了直後に 1 回だけ表示する画面。access token を Worker が永続化できない
 * (CF Secrets Store は read-only) ため、運用者が secret-inject skill で手動投入
 * するための値をここでのみ表示する (2026-07-08 方針転換、KV から移行)。 */
export const OAuthCompletePage: FC<{
  username: string;
  userNsid: string;
  tokenJson: string;
  prefix: string;
}> = ({ username, userNsid, tokenJson, prefix }) => (
  <Layout title="Flickr 認可完了" prefix={prefix}>
    <p>
      Flickr 認可が完了しました: <strong>{username}</strong> ({userNsid})
    </p>
    <p>
      <strong>この画面はこの 1 回しか表示されません。</strong>{" "}
      以下の値を <code>secret-inject</code> skill で <code>FLICKR_ACCESS_TOKEN_JSON</code>{" "}
      として今すぐ投入してください (CF Secrets Store の binding は read-only のため、
      Worker 自身はこの値を永続化できません)。
    </p>
    <pre style="background:#f3f4f6; padding:0.75rem; border-radius:0.4rem; overflow-x:auto; white-space:pre-wrap; word-break:break-all;">
      {tokenJson}
    </pre>
    <p>投入コマンド例 (値は必ず stdin から渡す — argv には置かない):</p>
    <pre style="background:#f3f4f6; padding:0.75rem; border-radius:0.4rem; overflow-x:auto; white-space:pre-wrap; word-break:break-all;">
      {`printf '%s' '<上記の JSON>' | bash ~/.claude/skills/secret-inject/scripts/inject-secret.sh FLICKR_ACCESS_TOKEN_JSON --targets gcp,cf`}
    </pre>
    <p>
      <code>wrangler.jsonc</code> の <code>secrets_store_secrets</code> に既に{" "}
      <code>FLICKR_ACCESS_TOKEN_JSON</code> の binding があるため、投入後は Worker が
      次回リクエストから新しい値を読みます (再 deploy 不要)。
    </p>
  </Layout>
);

function fileBadge(flickrId: string | null): { label: string; className: string } {
  if (flickrId === null) return { label: "未アップロード", className: "badge-pending" };
  if (flickrId === "SD_ZOMBIE") return { label: "SD消失", className: "badge-zombie" };
  return { label: "アップロード済", className: "badge-ok" };
}

/** 画像確認ページのクライアント側スクリプト。
 * - 回転: 表示だけ (Flickr の元写真は変えない)。角度は localStorage に保存し、
 *   サムネイルと拡大表示の両方に `data-rot` で効かせる
 * - 拡大表示: サムネイルのクリックで画面内に開き、← → (↑ ↓) で前後、R で回転、Esc で閉じる
 * JS が動かない場合はサムネイルのリンクが従来どおり別タブで開く。 */
export const IMAGES_PAGE_SCRIPT = `(() => {
  const KEY = "cam-images-rotation";
  const table = document.getElementById("images-table");
  const viewer = document.getElementById("viewer");
  const img = document.getElementById("viewer-img");
  const caption = document.getElementById("viewer-caption");
  const rotateBtn = document.getElementById("rotate-btn");
  if (!table || !viewer || !img || !caption || !rotateBtn) return;
  const links = Array.from(table.querySelectorAll("a.thumb-link"));
  let rot = 0;
  try { rot = (parseInt(localStorage.getItem(KEY) || "0", 10) || 0) % 360; } catch (e) {}
  let index = -1;
  const applyRot = () => {
    table.dataset.rot = "r" + rot;
    viewer.dataset.rot = "r" + rot;
    rotateBtn.textContent = "↻ 90° 回転 (いま " + rot + "°)";
  };
  const rotate = () => {
    rot = (rot + 90) % 360;
    try { localStorage.setItem(KEY, String(rot)); } catch (e) {}
    applyRot();
  };
  const preload = (i) => { if (links[i]) { const p = new Image(); p.src = links[i].href; } };
  const show = (i) => {
    if (links.length === 0) return;
    index = (i + links.length) % links.length;
    const a = links[index];
    img.src = a.href;
    caption.textContent = (index + 1) + " / " + links.length + "  " + (a.dataset.name || "");
    viewer.classList.add("open");
    preload(index + 1);
    preload(index - 1);
  };
  const close = () => { viewer.classList.remove("open"); img.removeAttribute("src"); index = -1; };
  links.forEach((a, i) => a.addEventListener("click", (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    show(i);
  }));
  rotateBtn.addEventListener("click", rotate);
  document.getElementById("viewer-rotate").addEventListener("click", rotate);
  document.getElementById("viewer-close").addEventListener("click", close);
  document.getElementById("viewer-prev").addEventListener("click", () => show(index - 1));
  document.getElementById("viewer-next").addEventListener("click", () => show(index + 1));
  viewer.addEventListener("click", (e) => { if (e.target === viewer) close(); });
  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return; // Ctrl+R (再読込) 等は奪わない
    if (e.key === "r" || e.key === "R") { rotate(); e.preventDefault(); return; }
    if (index < 0) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { show(index + 1); e.preventDefault(); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { show(index - 1); e.preventDefault(); }
    else if (e.key === "Escape") { close(); e.preventDefault(); }
  });
  applyRot();
})();`;

export const ImagesPage: FC<{
  date: string | null;
  availableDates: string[];
  files: CamFileRow[];
  userNsid: string | null;
  prefix: string;
}> = ({ date, availableDates, files, userNsid, prefix }) => (
  <Layout title="画像確認" prefix={prefix}>
    {availableDates.length === 0 ? (
      <p>まだデータがありません。</p>
    ) : (
      <>
        <div class="toolbar">
          <form method="get" action={`${prefix}/images`}>
            <label>
              日付:{" "}
              <select name="date" onchange="this.form.submit()">
                {availableDates.map((d) => (
                  <option value={d} selected={d === date}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
          </form>
          <button type="button" class="button" id="rotate-btn">
            ↻ 90° 回転
          </button>
          <span class="hint">画像をクリックで拡大 / ← → で前後 / R で回転 / Esc で閉じる</span>
        </div>
        <table id="images-table">
          <thead>
            <tr>
              <th>プレビュー</th>
              <th>時刻</th>
              <th>ファイル名</th>
              <th>状態</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => {
              const badge = fileBadge(f.flickrId);
              // 実写真 (数値 flickr_id) のみ /images/photo 経由でサムネイル表示。
              // SD_ZOMBIE / 未アップロードは画像が無い。
              const uploaded = f.flickrId !== null && /^\d+$/.test(f.flickrId);
              return (
                <tr>
                  <td class="thumb-cell">
                    {uploaded ? (
                      // date を付けて archive 済み写真も引けるようにする (Refs #28)
                      <a
                        class="thumb-link"
                        href={`${prefix}/images/photo/${f.flickrId}?date=${f.date}&size=b`}
                        data-name={f.name}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <span class="thumb-box">
                          <img class="thumb" src={`${prefix}/images/photo/${f.flickrId}?date=${f.date}&size=m`} alt={f.name} loading="lazy" />
                        </span>
                      </a>
                    ) : null}
                  </td>
                  <td>{f.hour}</td>
                  <td>{f.name}</td>
                  <td>
                    <span class={`badge ${badge.className}`}>{badge.label}</span>
                  </td>
                  <td>
                    {uploaded && userNsid ? (
                      <a href={`https://www.flickr.com/photos/${userNsid}/${f.flickrId}`} target="_blank" rel="noreferrer">
                        Flickr で見る
                      </a>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div id="viewer" role="dialog" aria-modal="true">
          <div class="bar">
            <span id="viewer-caption"></span>
            <span>
              <button type="button" id="viewer-rotate">↻ 90°</button>{" "}
              <button type="button" id="viewer-close">✕</button>
            </span>
          </div>
          <button type="button" class="nav prev" id="viewer-prev" aria-label="前の画像">‹</button>
          <img id="viewer-img" alt="" />
          <button type="button" class="nav next" id="viewer-next" aria-label="次の画像">›</button>
        </div>
        <script dangerouslySetInnerHTML={{ __html: IMAGES_PAGE_SCRIPT }} />
      </>
    )}
  </Layout>
);
