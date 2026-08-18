// 日次アーカイブ: D1 の当日確定分 cam_files メタデータを R2 に JSON で flush し、
// D1 を最小に保つ (画像バイナリは持たない — 画像本体は Flickr が正、
// Refs ohishi-exp/ohishi-logi#1 2026-07-08 方針)。
//
// key は `{date}.json` (例 `20260101.json`)。1 カメラ・日付単位検索のみという
// 前提なので、これ以上の索引構造は持たない。

import type { CamFileRow } from "./d1";
import { deleteByDate, listByDate } from "./d1";

export interface ArchivedDay {
  date: string;
  archivedAt: number;
  files: CamFileRow[];
}

function archiveKey(date: string): string {
  return `${date}.json`;
}

/**
 * 指定日の D1 行を R2 に JSON put してから D1 から削除する。
 * R2 は strong consistency なので put 成功確認後の削除で read-after-write の
 * 穴は無い。put が失敗したら delete しない (冪等 — 次回 flush が再試行できる)。
 * 戻り値はアーカイブした行数 (0 なら何もしていない)。
 */
export async function archiveDate(db: D1Database, bucket: R2Bucket, date: string, now: number): Promise<number> {
  const files = await listByDate(db, date);
  if (files.length === 0) return 0;

  const archived: ArchivedDay = { date, archivedAt: now, files };
  await bucket.put(archiveKey(date), JSON.stringify(archived), {
    httpMetadata: { contentType: "application/json" },
  });
  await deleteByDate(db, date);
  return files.length;
}

/** R2 の list 1 ページあたりの取得件数 (R2 の上限値)。 */
const LIST_PAGE_SIZE = 1000;

/**
 * アーカイブ済み日付一覧 (新しい順、最大 `limit` 件)。UI の日付ナビゲーション用。
 *
 * R2 の `list()` は key の**辞書順 (昇順)** で先頭から返すため、`limit` を
 * そのまま渡すと **古い方**だけが返る (その後に並べ替えても、落ちた新しい日は
 * 戻ってこない — Refs #40)。key は `archiveKey()` が作る `YYYYMMDD.json` 固定で
 * 辞書順 = 日付順なので、`truncated`/`cursor` で最後まで辿り**末尾 `limit` 件**
 * を残せば新しい方が取れる。保持は常に `limit` 件までなので、アーカイブが
 * 何日ぶんに増えてもメモリは一定。
 */
export async function listArchivedDates(bucket: R2Bucket, limit = 60): Promise<string[]> {
  if (limit <= 0) return [];

  const tail: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const listed = await bucket.list({ limit: LIST_PAGE_SIZE, cursor });
    for (const o of listed.objects) {
      // key 形式が違うものは辞書順 = 日付順の前提を壊すので数に入れない
      // (`archiveKey()` 以外の書き手は居ない想定 — 念のための保険)。
      if (/^\d{8}\.json$/.test(o.key)) tail.push(o.key.slice(0, 8));
    }
    // 末尾 `limit` 件だけ残す (先頭 = 古い方から捨てる)
    if (tail.length > limit) tail.splice(0, tail.length - limit);
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }

  return tail.reverse();
}

/** 指定日のアーカイブを読む。無ければ null。 */
export async function getArchive(bucket: R2Bucket, date: string): Promise<ArchivedDay | null> {
  const obj = await bucket.get(archiveKey(date));
  if (!obj) return null;
  return JSON.parse(await obj.text()) as ArchivedDay;
}
