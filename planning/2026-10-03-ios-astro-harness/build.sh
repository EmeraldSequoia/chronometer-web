#!/bin/zsh
# Builds and runs the time-controller astronomy harness (plan §8.1) on this Mac, from the real
# esastro, estime, eslocation and esutil sources — no Xcode or iOS SDK needed.  It links the
# ios-backports clones; esutil (not among them) is cloned into a temp dir unless its src dir is
# given.  With ASTRO_ALT set to another ESAstronomy.cpp (for example `git -C ios-backports/esastro
# show HEAD~1:src/ESAstronomy.cpp > /tmp/before.cpp`), a second binary is built from that file, to
# show a fix's effect side by side.
#
#   planning/2026-10-03-ios-astro-harness/build.sh [esutil-src-dir]
#
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
B=$ROOT/ios-backports
U=${1:-}
if [ -z "$U" ]; then
    U=${TMPDIR:-/tmp}/esutil-for-harness/src
    if [ ! -d "$U" ]; then
        git clone --quiet https://github.com/EmeraldSequoia/esutil.git "$(dirname "$U")"
    fi
fi
OUT=${HARNESS_OUT:-${TMPDIR:-/tmp}/ios-astro-harness}
mkdir -p "$OUT/obj"

FLAGS=(-DES_MACOS=1 -include "$HERE/prefix.h" -I "$B/esastro/src" -I "$B/esastro/Willmann-Bell" -I "$B/estime/src" -I "$B/eslocation/src" -I "$U" -I "$HERE" -Wno-everything -O1 -std=c++11)
SRCS=(
    "$B/esastro/src/ESAstronomy.cpp" "$B/esastro/src/ESAstronomyCache.cpp" "$B/esastro/src/ESTimeLocAstroEnvironment.cpp" "$B/esastro/src/ESSunAltitudeTable.cpp" "$B/esastro/Willmann-Bell/ESWillmannBell.cpp"
    "$B/estime/src/ESWatchTime.cpp" "$B/estime/src/ESWatchTime_Cocoa.mm" "$B/estime/src/ESCalendar.cpp" "$B/estime/src/ESCalendar_Cocoa.mm" "$B/estime/src/ESTimeEnvironment.cpp"
    "$B/estime/src/ESTime.cpp" "$B/estime/src/ESSystemTimeDriver.cpp" "$B/estime/src/ESTimeSourceDriver.cpp" "$B/estime/src/ESLeapSecond.cpp" "$B/estime/src/ESTimer.cpp" "$B/estime/src/ESTimeCalibrator.cpp" "$B/estime/src/ESFakeTimeDriver.cpp" "$B/estime/src/ESSystemTimeBase_singleBase.cpp"
    "$B/eslocation/src/ESTimeLocEnvironment.cpp" "$B/eslocation/src/ESLocation.cpp" "$B/eslocation/src/ESDeviceLocationManager.cpp" "$B/eslocation/src/ESDeviceLocationManager_Cocoa.mm"
    "$U/ESUtil.cpp" "$U/ESUtil_Cocoa.mm" "$U/ESUtil_MacOS.mm" "$U/ESErrorReporter.cpp" "$U/ESErrorReporter_Cocoa.mm" "$U/ESThread.cpp" "$U/ESThread_Cocoa.mm" "$U/ESThread_pthreads.cpp" "$U/ESLock_pthreads.cpp"
    "$U/ESUserPrefs_Cocoa.mm" "$U/ESUserString.cpp" "$U/ESUserString_Cocoa.mm" "$U/ESTrace.cpp" "$U/ESInterThreadObserver.cpp" "$U/ESMath.cpp" "$U/ESFile.cpp" "$U/ESFile_Cocoa.mm" "$U/ESFile_simpleResource.cpp" "$U/ESFileArray.cpp" "$U/ESOfflineLogger.cpp"
    "$HERE/stubs.mm" "$HERE/main.mm"
)
compile() {
    local f=$1 o=$2
    case $f in
        *.mm) clang++ -x objective-c++ -fno-objc-arc "${FLAGS[@]}" -c "$f" -o "$o" ;;
        *)    clang++ "${FLAGS[@]}" -c "$f" -o "$o" ;;
    esac
}
echo "compiling ${#SRCS[@]} files into $OUT/obj"
for f in "${SRCS[@]}"; do
    compile "$f" "$OUT/obj/$(basename "$f").o"
done
LIBS=(-framework Foundation -framework CoreLocation -framework ScreenSaver)
clang++ -o "$OUT/harness" "$OUT"/obj/*.o "${LIBS[@]}"
echo "built $OUT/harness"
if [ -n "${ASTRO_ALT:-}" ]; then
    compile "$ASTRO_ALT" "$OUT/ESAstronomy_alt.o"
    clang++ -o "$OUT/harness_alt" "$OUT/ESAstronomy_alt.o" $(ls "$OUT"/obj/*.o | grep -v '/ESAstronomy.cpp.o$') "${LIBS[@]}"
    echo "built $OUT/harness_alt from $ASTRO_ALT"
fi
echo
"$OUT/harness" 2>/dev/null
if [ -n "${ASTRO_ALT:-}" ]; then
    echo
    echo "=== the same, built from $ASTRO_ALT ==="
    "$OUT/harness_alt" 2>/dev/null
fi
