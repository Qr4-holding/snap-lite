#!/usr/bin/env bash
# Builds the signed Android app for the skin in SKIN (default ekp11) pointing at HOST. It opens the web app full screen (Trusted Web Activity),
# so camera, sign-in cookies and the phone's share sheet are the real Chrome ones.
#   HOST=ekp11.72-61-18-77.sslip.io KEYSTORE=/path/release.jks KS_PASS=... ./android/build.sh
set -euo pipefail
cd "$(dirname "$0")"
SKIN=${SKIN:-ekp11}; HOST=${HOST:?HOST required}; KEYSTORE=${KEYSTORE:?}; KS_PASS=${KS_PASS:?}; VERSION=${VERSION:-1}; VNAME=${VNAME:-0.1.0}
export ANDROID_HOME=${ANDROID_HOME:-/opt/android}
J=../skins/$SKIN/skin.json
get() { node -e "console.log(require('$J').$1)"; }
APP_ID=$(get app_id); NAME=$(get app_name); ACCENT=$(get accent)
OUT=build-out; rm -rf $OUT; mkdir -p $OUT
cp -r template $OUT/proj; P=$OUT/proj
sed -i "s|@APP_ID@|$APP_ID|g;s|@HOST@|$HOST|g;s|@NAME@|$NAME|g;s|@ACCENT@|$ACCENT|g;s|@VCODE@|$VERSION|g;s|@VNAME@|$VNAME|g" $(grep -rl "@APP_ID@\|@HOST@\|@NAME@\|@ACCENT@\|@VCODE@\|@VNAME@" $P)
# icons from the live server so they are exactly what the web app uses
for d in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  n=${d%%:*}; s=${d##*:}; mkdir -p $P/app/src/main/res/mipmap-$n
  node -e "require('sharp')('../skins/$SKIN/logo.png').resize($s*0.78|0,$s*0.78|0,{fit:'inside'}).toBuffer().then(b=>require('sharp')({create:{width:$s,height:$s,channels:4,background:'#ffffff'}}).composite([{input:b,gravity:'center'}]).png().toFile('$P/app/src/main/res/mipmap-$n/ic_launcher.png'))"
done
cat > $P/local.properties <<EOP
sdk.dir=$ANDROID_HOME
EOP
cat > $P/keystore.properties <<EOP
storeFile=$(realpath "$KEYSTORE")
storePassword=$KS_PASS
keyAlias=release
keyPassword=$KS_PASS
EOP
(cd $P && gradle --no-daemon -q assembleRelease)
APK=$(find $P -name "*-release.apk" | head -1)
cp "$APK" ../apk/$SKIN-snap.apk; echo "$VNAME" > ../apk/version.txt
FP=$(keytool -list -v -keystore "$KEYSTORE" -storepass "$KS_PASS" -alias release 2>/dev/null | grep "SHA256:" | sed 's/.*SHA256: //')
# one assetlinks file holds an entry per skin's app (the server only publishes the entry for the skin it runs)
APP_ID=$APP_ID FP=$FP node -e "
const fs=require('fs'),f='../apk/assetlinks.json';let a=[];try{a=JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){}
a=a.filter(e=>e.target.package_name!==process.env.APP_ID);
a.push({relation:['delegate_permission/common.handle_all_urls'],target:{namespace:'android_app',package_name:process.env.APP_ID,sha256_cert_fingerprints:[process.env.FP]}});
fs.writeFileSync(f,JSON.stringify(a))"
echo "APK: apk/$SKIN-snap.apk  fingerprint $FP"
