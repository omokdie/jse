#!/bin/sh
# Fetch the Google Fonts (OFL) Korean families used to train the Hangul lyric
# recogniser (sparse checkout of github.com/google/fonts, ~170 MB). The fonts are
# training data only: nothing is bundled with the app.
#   sh tools/omr/hangul/fetch_fonts.sh [target dir, default /tmp/gfonts]   → $JSE_GFONTS = <dir>/ofl
set -e
DIR="${1:-/tmp/gfonts}"
if [ ! -d "$DIR/.git" ]; then
  git clone --depth 1 --filter=blob:none --sparse https://github.com/google/fonts "$DIR"
fi
cd "$DIR"
git sparse-checkout set \
  ofl/nanummyeongjo ofl/nanumgothic ofl/nanumgothiccoding ofl/songmyung ofl/hahmlet ofl/diphylleia \
  ofl/gothica1 ofl/sunflower ofl/dongle ofl/orbit \
  ofl/jua ofl/dohyeon ofl/blackhansans ofl/gugi ofl/stylish ofl/yeonsung ofl/himelody ofl/poorstory ofl/gaegu \
  ofl/nanumpenscript ofl/nanumbrushscript ofl/cutefont ofl/gamjaflower ofl/singleday ofl/dokdo ofl/eastseadokdo \
  ofl/gowunbatang ofl/gowundodum ofl/ibmplexsanskr
echo "fonts in $DIR/ofl (export JSE_GFONTS=$DIR/ofl if not the default /tmp/gfonts/ofl)"
