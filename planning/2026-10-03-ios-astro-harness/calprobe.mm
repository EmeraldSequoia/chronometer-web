// calprobe.mm — what the time controller's date fields compose (plan §16): typed components through
// ESCalendar_timeIntervalFromLocalDateComponents in the clock's zone, clamped to the astronomy range,
// read back through ESCalendar_localDateComponentsFromTimeInterval as the fields and the strip would show.
//
// Build against the harness's objects (after build.sh has made them under $HARNESS_OUT/obj; FLAGS and
// LIBS as in build.sh), leaving out main.mm.o and any ESAstronomy_before/_alt object:
//   clang++ -x objective-c++ -fno-objc-arc "${FLAGS[@]}" -c calprobe.mm -o calprobe.o
//   clang++ -o calprobe calprobe.o $(ls $OUT/obj/*.o | grep -v '/main.mm.o$\|_before\|_alt') "${LIBS[@]}"
// Run 2026-10-03: every instant exact; 1582 Oct 10 (in the gap) reads as Julian and shows as Oct 20;
// the range limits are UTC instants, so Pacific time's last typeable moment is 2800 Dec 31 16:00.
#import <Foundation/Foundation.h>
#include "ESPlatform.h"
#include "ESUtil.hpp"
#include "ESTime.hpp"
#include "ESThread.hpp"
#include "ESCalendar.hpp"
#include "ESTimeLocAstroEnvironment.hpp"
#include <stdio.h>

static const char *fmt(ESTimeInterval t, ESTimeZone *tz, char *buf) {
    ESDateComponents cs;
    ESCalendar_localDateComponentsFromTimeInterval(t, tz, &cs);
    sprintf(buf, "%4d-%02d-%02d %02d:%02d:%06.3f %s", cs.year, cs.month, cs.day, cs.hour, cs.minute, cs.seconds, cs.era == 0 ? "BCE" : "CE ");
    return buf;
}

int main() {
    @autoreleasepool {
        ESTime::startOfMain("calprobe");
        ESUtil::init();
        ESThread::inMainThread();
        ESTime::init(ESSystemTimeMakerFlag);
        ESTimeLocAstroEnvironment *env = new ESTimeLocAstroEnvironment("America/Los_Angeles", "San Francisco", 37.7749, -122.4194);
        ESTimeZone *tz = env->estz();
        struct Case { const char *what; int era, year, month, day, hour, minute; };
        Case cases[] = {
            {"2026 Oct 3 12:00", 1, 2026, 10, 3, 12, 0},
            {"1582 Oct 4 12:00 (Julian)", 1, 1582, 10, 4, 12, 0},
            {"1582 Oct 15 12:00 (Gregorian)", 1, 1582, 10, 15, 12, 0},
            {"1582 Oct 10 12:00 (in the gap)", 1, 1582, 10, 10, 12, 0},
            {"44 BCE Mar 15 12:00", 0, 44, 3, 15, 12, 0},
            {"4000 BCE Jan 1 00:00", 0, 4000, 1, 1, 0, 0},
            {"4001 BCE Jan 1 00:00 (below the range)", 0, 4001, 1, 1, 0, 0},
            {"2800 Dec 31 23:59", 1, 2800, 12, 31, 23, 59},
            {"2801 Jan 1 00:00 (above the range)", 1, 2801, 1, 1, 0, 0},
            {"2024 Feb 30 12:00 (no such day)", 1, 2024, 2, 30, 12, 0},
            {"2026 Mar 8 02:30 (spring-forward gap)", 1, 2026, 3, 8, 2, 30},
            {"2026 Nov 1 01:30 (fall-back, ambiguous)", 1, 2026, 11, 1, 1, 30},
        };
        char a[64], b[64];
        for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
            const Case &c = cases[i];
            ESDateComponents cs = {c.era, c.year, c.month, c.day, c.hour, c.minute, 0};
            ESTimeInterval t = ESCalendar_timeIntervalFromLocalDateComponents(tz, &cs);
            bool clamped = false;
            if (t < ESMinimumSupportedAstroDate) { t = ESMinimumSupportedAstroDate; clamped = true; }
            else if (t > ESMaximumSupportedAstroDate) { t = ESMaximumSupportedAstroDate; clamped = true; }
            ESDateComponents u;
            ESCalendar_UTCDateComponentsFromTimeInterval(t, &u);
            printf("%-42s -> local %s   UTC %4d-%02d-%02d %02d:%02d:%06.3f %s  t=%.3f off=%.0f%s\n", c.what, fmt(t, tz, a), u.year, u.month, u.day, u.hour, u.minute, u.seconds, u.era == 0 ? "BCE" : "CE", t, ESCalendar_tzOffsetForTimeInterval(tz, t), clamped ? "   [clamped: AT LIMIT]" : "");
        }
        ESDateComponents cs = {1, 1582, 10, 4, 12, 0, 0};
        ESTimeInterval t = ESCalendar_timeIntervalFromLocalDateComponents(tz, &cs);
        printf("%-42s -> local %s\n", "1582 Oct 4 12:00 + 86400 s", fmt(t + 86400, tz, b));
    }
    return 0;
}
