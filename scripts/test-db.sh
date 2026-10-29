#!/usr/bin/env bash
# 在本機 PostgreSQL 建立暫時資料庫，套用 Supabase 模擬環境、正式 migration，再執行權限測試。
# 需求：本機有 PostgreSQL 15+ 及可用的 psql；預設以 postgres 身分連線。
set -euo pipefail
DB="${KUMA_TEST_DB:-kuma_rls_test}"
PSQL="${PSQL:-psql}"
cd "$(dirname "$0")/.."
$PSQL -v ON_ERROR_STOP=1 -q -d postgres -c "drop database if exists $DB" -c "create database $DB"
$PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f supabase/tests/local_mock_supabase.sql
for f in supabase/migrations/*.sql; do
  $PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f "$f"
done
$PSQL -v ON_ERROR_STOP=1 -q -d "$DB" -f supabase/tests/rls_test.sql 2>&1 >/dev/null | sed -E "s/^psql:[^ ]+ //"
