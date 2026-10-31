#!/bin/bash
# 복구 리허설: "백업 파일 하나로 빈 DB에 학원 데이터를 되살릴 수 있는가"를 실제로 해 본다.
# Render의 'Create export' 파일(.dir.tar.gz, pg_dump 디렉터리 형식)과 같은 형식으로 시험한다.
#   사용: bash scripts/restore-drill.sh <원본 DB 주소> <복구용 빈 DB 이름> [Render export 파일]
#   - export 파일을 주면 그 파일로 복구, 없으면 원본 DB에서 같은 형식으로 백업을 만든 뒤 복구
#   - 운영 DB에는 읽기(pg_dump)만 한다. 복구는 반드시 '새로 만든 빈 DB'에만.
set -euo pipefail
SRC="$1"; TARGET_DB="$2"; EXPORT="${3:-}"
BIN=${PG_BIN:-/usr/lib/postgresql/16/bin}
WORK=$(mktemp -d)
ADMIN_URL=${ADMIN_URL:-$SRC}
if [ -z "$EXPORT" ]; then
  echo "① 백업 만들기 (pg_dump 디렉터리 형식 → tar.gz)"
  $BIN/pg_dump --format=directory --no-owner --no-privileges --file="$WORK/dump" "$SRC"
  tar -czf "$WORK/backup.dir.tar.gz" -C "$WORK" dump
  EXPORT="$WORK/backup.dir.tar.gz"
fi
echo "   백업 파일: $(du -h "$EXPORT" | cut -f1)"
echo "② 빈 DB 만들기: $TARGET_DB"
$BIN/psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $TARGET_DB" -c "CREATE DATABASE $TARGET_DB ENCODING 'UTF8' TEMPLATE template0"
TARGET_URL=$(echo "$ADMIN_URL" | sed -E "s#/[^/?]+(\?|$)#/$TARGET_DB\1#")
echo "③ 복구 (pg_restore)"
mkdir -p "$WORK/x"; tar -xzf "$EXPORT" -C "$WORK/x"
DIR=$(dirname "$(find "$WORK/x" -name toc.dat | head -1)")
$BIN/pg_restore --no-owner --no-privileges --exit-on-error --dbname="$TARGET_URL" "$DIR"
echo "④ 표마다 행 수 비교 (원본 vs 복구본)"
Q="SELECT string_agg(t||'='||n, ' ' ORDER BY t) FROM (SELECT relname t, n_live_tup n FROM pg_stat_user_tables) s"
COUNTS="SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1"
DIFF=0
for T in $($BIN/psql "$TARGET_URL" -At -c "$COUNTS"); do
  A=$($BIN/psql "$SRC" -At -c "SET app.bypass_rls='on'; SELECT count(*) FROM \"$T\"" | tail -1)
  B=$($BIN/psql "$TARGET_URL" -At -c "SET app.bypass_rls='on'; SELECT count(*) FROM \"$T\"" | tail -1)
  if [ "$A" != "$B" ]; then echo "   ✘ $T: 원본 $A / 복구 $B"; DIFF=1; else echo "   ✔ $T: $A"; fi
done
rm -rf "$WORK"
[ $DIFF = 0 ] && echo "복구 리허설 성공" || { echo "복구 리허설 실패"; exit 1; }
