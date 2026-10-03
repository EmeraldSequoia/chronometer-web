// The NTP driver is never made (the harness runs on the plain system clock); the time service only has to link
#include "ESPlatform.h"
#include "ESNTPDriver.hpp"
/*static*/ ESTimeSourceDriver *ESNTPDriver::makeOne() { return NULL; }
/*static*/ void ESNTPDriver::setAppSignature(const char *fourByteAppSig) { }
