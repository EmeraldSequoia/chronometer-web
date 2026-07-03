#!/bin/bash
# Generate Kyoto unified XML from iOS reference, with mode-conditional expressions.
#
# HISTORICAL ONLY — DO NOT RUN. Kyoto-I.xml has since been edited directly
# (e.g. displayName/description attributes on <watch>) and this script would
# overwrite those changes. Kept for reference on how the face was originally
# generated; src/watch/assets/kyoto/Kyoto-I.xml is the source of truth.
cat > src/watch/assets/kyoto/Kyoto-I.xml << 'XMLEOF'
<?xml version="1.0" encoding="UTF-8"?>
<!-- Kyoto: unified wadokei face (Kyoto I + Kyoto II merged)
     kyMode=0: Variable hour widths (moving dial, constant-speed hand)
     kyMode=1: Constant hour widths (fixed dial, variable-speed hand)
-->
<watch name='Kyoto' landscapeZoomFactor='0.9' beatsPerSecond='5' bezelColor='rgb(160,160,160)' urlAbbrev='ky'>

  <init expr='faceRad=136, outrRad=135, jSignRad=145, midoRad=109, jNumbRad=116, midiRad=88, innRad=82, hrRad=67' />
  <init expr='jhrRad=(midoRad+outrRad)/2, jstRad=(midiRad+midoRad)/2-2' />
  <init expr='subfs=9, subR=30, subRIn=subR-subfs-1' />
  <init expr='jhrLen=innRad, hrLen=hrRad*.65, minLen=hrRad*.80, secLen=hrRad, mWidth=1.25' />
  <init expr='faceColor=0xffe0e0e0, textColor=black, innerBg=0x80e0e0e0, dstBorder=0x80a0a0a0, subBg=0xffe7e7e7, midbg=0x40000000' />
  <init expr='hrColor=minColor=black, secColor=0xff000000' />
  <init expr='kyMode=0' />

  <static name='front' modes='front' n='3'>
    <QDial name='outer'       x='0' y='0' modes='front' radius='outrRad'  markWidth='mWidth' marks='outer' bgColor='clear' />
    <QDial name='mido'        x='0' y='0' modes='front' radius='midoRad'  markWidth='mWidth' marks='outer' bgColor='midbg' />
    <QDial name='midi'        x='0' y='0' modes='front' radius='midiRad'  markWidth='mWidth' marks='outer' bgColor='clear' />
    <QDial name='tick48'      x='0' y='0' modes='front' radius='midiRad'  markWidth='mWidth' marks='tickOut' nMarks='48' mSize='midiRad-innRad' bgColor='clear' />
    <QDial name='inner'       x='0' y='0' modes='front' radius='innRad'   markWidth='mWidth+1' marks='outer' bgColor='clear' />
    <QDial name='tick12'      x='0' y='0' modes='front' radius='outrRad'  markWidth='mWidth' marks='tickOut' nMarks='12' mSize='outrRad-innRad' angle0='pi/12' bgColor='clear' />
    <QDial name='inn2'        x='0' y='0' modes='front' radius='hrRad'    markWidth='mWidth' marks='outer' bgColor='clear' />
    <QDial name='hour tic24'  x='0' y='0' modes='front' radius='hrRad'    markWidth='2.0' marks='tickOut' nMarks='12' mSize='5' bgColor='clear' />
    <QDial name='hour tic96'  x='0' y='0' modes='front' radius='hrRad'    markWidth='0.5' marks='tickOut' nMarks='60' mSize='5' bgColor='clear' />
    <QDial name='inn3'        x='0' y='0' modes='front' radius='hrRad-5'  markWidth='mWidth' marks='outer' bgColor='0x20000000' />
    <Image name='berry shadow' x='0.7' y='33.7' modes='front' src='../partsBin/berry-shadow.png'/>
    <Image name='berry'        x='0' y='35' modes='front' src='../partsBin/berry.png'/>
    <Image name='decoration'   x='0' y='0' modes='front' src='rose.png' />
  </static>

  <QdayNightRing name='daytime' x='0' y='0' modes='front' outerRadius='midoRad+1.5' innerRadius='midoRad-1.5' update='updateAtNextSunriseOrSunset' strokeColor='black' fillColor='black' input='0' numWedges='12' planetNumber='planetMidnightSun' masterOffset='pi' />

XMLEOF

# Generate 12 kanji sign spoke hands (午未申酉戌亥子丑寅卯辰巳)
SIGNS=(午 未 申 酉 戌 亥 子 丑 寅 卯 辰 巳)
for i in $(seq 0 11); do
  printf "  <Qhand name='jh%02d' x='0' y='0' modes='front' type='spoke' offsetRadius='jhrRad' fillColor='black' strokeColor='black' text='%s' fontSize='21' fontName='Helvetica-Bold' oFillColor='clear' angle='0' offsetAngle='kyMode==0 ? angleForJapanHour(%2d) : %d*pi/6' update='updateAtNextSunriseOrSunset' />\n" \
    $i "${SIGNS[$i]}" $i $i >> src/watch/assets/kyoto/Kyoto-I.xml
done

# Generate 12 kanji number spoke hands (九八七六五四 repeated)
NUMS=(九 八 七 六 五 四 九 八 七 六 五 四)
for i in $(seq 0 11); do
  printf "  <Qhand name='js%02d' x='0' y='0' modes='front' type='spoke' offsetRadius='jstRad' fillColor='black' strokeColor='black' text='%s' fontSize='15' fontName='AppleGothic' oFillColor='clear' angle='0' offsetAngle='kyMode==0 ? angleForJapanHour(%2d) : %d*pi/6' update='updateAtNextSunriseOrSunset' />\n" \
    $i "${NUMS[$i]}" $i $i >> src/watch/assets/kyoto/Kyoto-I.xml
done

# Generate 48 wire tick hands (4 per hour, at .00 .25 .50 .75)
for h in $(seq 0 11); do
  for q in 0 1 2 3; do
    n=$(echo "$h + $q * 0.25" | bc)
    nf=$(printf "%.2f" $n)
    # Half-hour ticks (.50) are wider and extend to outrRad
    if [ $q -eq 2 ]; then
      W=2; LW="1.5"; LEN="outrRad"
    else
      W=1; LW=".75"; LEN="midiRad"
    fi
    # Use hex for names when h >= 10
    if [ $h -lt 10 ]; then
      HEX=$h
    elif [ $h -eq 10 ]; then
      HEX="a"
    else
      HEX="b"
    fi
    printf "  <Qhand name='tic%s%d' x='0' y='0' modes='front' type='wire' width='%d' lineWidth='%s' length='%s' length2='midiRad-5' angle='kyMode==0 ? angleForJapanHour(%s) : %s*pi/6' update='updateAtNextSunriseOrSunset' />\n" \
      "$HEX" $q $W "$LW" "$LEN" "$nf" "$nf" >> src/watch/assets/kyoto/Kyoto-I.xml
  done
done

# Generate 24 number spoke hands for 24-hour dial
LABELS=(12 13 14 15 16 17 18 19 20 21 22 23 24 1 2 3 4 5 6 7 8 9 10 11)
for i in $(seq 0 23); do
  printf "  <Qhand name='n24_%02d' x='0' y='0' modes='front' type='spoke' offsetRadius='innRad-1' fillColor='black' strokeColor='black' text='%s' fontSize='11' fontName='Times New Roman' oFillColor='clear' angle='0' offsetAngle='kyMode==0 ? %d*pi/12+pi : temporalAngleFor24Hour(%d)' update='updateAtNextSunriseOrSunset' />\n" \
    $i "${LABELS[$i]}" $i $i >> src/watch/assets/kyoto/Kyoto-I.xml
done

# Add the image hand and close
cat >> src/watch/assets/kyoto/Kyoto-I.xml << 'XMLEOF'

  <hand name='jhr' x='0' y='0' z='3' thick='2' modes='front' xAnchor='70' yAnchor='70' src='hand.png' update='1' angle='kyMode==0 ? hour24ValueAngle()+pi : japanHourValueAngle()' />
</watch>
XMLEOF

echo "Generated Kyoto-I.xml"
