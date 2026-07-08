// OAuth 認可/状況確認・画像確認用の簡易 HTML ページ (Hono JSX)。
// API (JSON) 応答とは別に、人間がブラウザで操作するための最小限の UI。

import type { FC } from "hono/jsx";

import type { CamFileRow, DayStats } from "./d1";

const Layout: FC<{ title: string; children?: unknown }> = ({ title, children }) => (
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
        a.button { display: inline-block; background: #0ea5e9; color: #fff; padding: 0.5rem 1rem; border-radius: 0.4rem; text-decoration: none; }
        nav a { margin-right: 1rem; }
      `}</style>
    </head>
    <body>
      <nav>
        <a href="/">状況</a>
        <a href="/images">画像確認</a>
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
}> = ({ authorized, username, days }) => (
  <Layout title="cf-flickr-cam-worker">
    {authorized ? (
      <p>
        Flickr に接続済み: <strong>{username}</strong>
      </p>
    ) : (
      <p>
        Flickr 未接続です。
        <a class="button" href="/oauth/start">
          Flickr に接続
        </a>
      </p>
    )}
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
                <a href={`/images?date=${d.date}`}>{d.date}</a>
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

function fileBadge(flickrId: string | null): { label: string; className: string } {
  if (flickrId === null) return { label: "未アップロード", className: "badge-pending" };
  if (flickrId === "SD_ZOMBIE") return { label: "SD消失", className: "badge-zombie" };
  return { label: "アップロード済", className: "badge-ok" };
}

export const ImagesPage: FC<{
  date: string | null;
  availableDates: string[];
  files: CamFileRow[];
  userNsid: string | null;
}> = ({ date, availableDates, files, userNsid }) => (
  <Layout title="画像確認">
    {availableDates.length === 0 ? (
      <p>まだデータがありません。</p>
    ) : (
      <>
        <form method="get" action="/images">
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
        <table>
          <thead>
            <tr>
              <th>時刻</th>
              <th>ファイル名</th>
              <th>状態</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => {
              const badge = fileBadge(f.flickrId);
              return (
                <tr>
                  <td>{f.hour}</td>
                  <td>{f.name}</td>
                  <td>
                    <span class={`badge ${badge.className}`}>{badge.label}</span>
                  </td>
                  <td>
                    {f.flickrId && f.flickrId !== "SD_ZOMBIE" && userNsid ? (
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
      </>
    )}
  </Layout>
);
