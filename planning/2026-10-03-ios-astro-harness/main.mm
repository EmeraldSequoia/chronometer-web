// Replays the §8.2 gold instants of planning/2026-09-25-ios-backport-observatory-time-controller.md
// through the real esastro searches the Observatory time controller makes (EOTimeStepper
// astroJumpInDirection:), so their results can be compared with the web engine's.  Build and run
// with build.sh next to this file.
#import <Foundation/Foundation.h>
#include "ESPlatform.h"
#include "ESUtil.hpp"
#include "ESTime.hpp"
#include "ESThread.hpp"
#include "ESCalendar.hpp"
#include "ESWatchTime.hpp"
#include "ESTimeLocAstroEnvironment.hpp"
#include "ESAstronomy.hpp"
#include <stdio.h>
#include <math.h>

static ESTimeInterval utc(int y, int mo, int d, int h, int mi) {
    ESDateComponents cs;
    cs.era = 1; cs.year = y; cs.month = mo; cs.day = d; cs.hour = h; cs.minute = mi; cs.seconds = 0;
    return ESCalendar_timeIntervalFromUTCDateComponents(&cs);
}

static const char *fmtUTC(ESTimeInterval t) {
    static char buffers[4][32];
    static int which = 0;
    char *buf = buffers[which++ % 4];
    if (isnan(t)) {
        snprintf(buf, 32, "%s", "none");
    } else {
        ESDateComponents cs;
        ESCalendar_UTCDateComponentsFromTimeInterval(t, &cs);
        snprintf(buf, 32, "%04d-%02d-%02d %02d:%02d:%02d", cs.year, cs.month, cs.day, cs.hour, cs.minute, (int)floor(cs.seconds + 0.5));
    }
    return buf;
}

static void row(const char *body, const char *event, ESTimeInterval next, ESTimeInterval prev) {
    printf("| %-8s | %-7s | %s | %s |\n", body, event, fmtUTC(next), fmtUTC(prev));
}

int main(int argc, char **argv) {
    @autoreleasepool {
        // The app's own startup order (main.mm, then the app delegate); the plain system clock
        // stands in for NTP, since the harness never asks for the present
        ESTime::startOfMain("harness");
        ESUtil::init();
        ESThread::inMainThread();
        ESTime::init(ESSystemTimeMakerFlag);

        struct Site { const char *name; const char *tz; double lat, lon; ESTimeInterval t; const int *bodies; int n; bool phase; };
        static const int sfBodies[] = {0, 1, 6, 7, 9};
        static const int lyBodies[] = {0, 1};
        static const char *names[10] = {"Sun", "Moon", "Mercury", "Venus", "Earth", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"};
        Site sites[] = {
            {"San Francisco", "America/Los_Angeles", 37.7749, -122.4194, utc(2026, 9, 25, 20, 0), sfBodies, 5, true},
            {"Longyearbyen", "Arctic/Longyearbyen", 78.22, 15.63, utc(2026, 11, 20, 12, 0), lyBodies, 2, false},
        };
        for (size_t s = 0; s < sizeof(sites) / sizeof(sites[0]); s++) {
            Site &site = sites[s];
            printf("\n## %s, from %s UTC\n| body | event | next | previous |\n|---|---|---|---|\n", site.name, fmtUTC(site.t));
            ESTimeLocAstroEnvironment *env = new ESTimeLocAstroEnvironment(site.tz, site.name, site.lat, site.lon);
            ESWatchTime watch(site.t);   // frozen at the instant, as the controller stops the clock before every search
            ESAstronomyManager *astro = env->astronomyManager();
            for (int i = 0; i < site.n; i++) {
                int p = site.bodies[i];
                astro->setupLocalEnvironmentForThreadFromActionButton(false, &watch);
                row(names[p], "rise", astro->nextPlanetriseForPlanetNumber(p), astro->prevPlanetriseForPlanetNumber(p));
                row(names[p], "set", astro->nextPlanetsetForPlanetNumber(p), astro->prevPlanetsetForPlanetNumber(p));
                row(names[p], "transit", astro->nextPlanettransit(p), astro->prevPlanettransit(p));
                astro->cleanupLocalEnvironmentForThreadFromActionButton(false);
            }
            if (site.phase) {
                astro->setupLocalEnvironmentForThreadFromActionButton(false, &watch);
                row("Moon", "phase", astro->nextMoonPhase(), astro->prevMoonPhase());
                astro->cleanupLocalEnvironmentForThreadFromActionButton(false);
            }
            delete env;
        }
    }
    return 0;
}
