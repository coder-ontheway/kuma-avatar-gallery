import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Supabase 對 API 角色啟用 pg_safeupdate：不帶 WHERE 的 UPDATE／DELETE 會直接失敗。
// 本機 PostgreSQL 沒有這個擴充，所以用靜態檢查擋下這類寫法。
const dir = join(__dirname, "../../supabase/migrations");

describe("migrations", () => {
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
    it(`${file}：UPDATE／DELETE 都有 WHERE`, () => {
      const sql = readFileSync(join(dir, file), "utf8").replace(/--.*$/gm, "");
      const statements = sql.split(";").map((s) => s.trim().toLowerCase());
      const bad = statements.filter(
        (s) => /(^|\s)(delete\s+from|update)\s+[a-z_."]+(\s|$)/.test(s) && !/\swhere\s/.test(s + " ") && !/^(create|grant|revoke|alter|insert)/.test(s),
      );
      expect(bad).toEqual([]);
    });
  }
});
