#include <Arduino.h>
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>

// ================= TFT =================
#define TFT_CS   10
#define TFT_DC    7
#define TFT_RST   8

Adafruit_ILI9341 tft(TFT_CS, TFT_DC, TFT_RST);

// ================= Battery test graphic state =================
static bool batteryGraphicInitialized = false;
static bool fifthBarOn = true;   // true = 5/5, false = 4/5

// Battery position and size
static const int BAT_X = 25;
static const int BAT_Y = 55;
static const int BAT_W = 210;
static const int BAT_H = 80;

static const int CAP_W = 10;
static const int CAP_H = 36;
static const int CAP_GAP = 6;

static const int BAR_COUNT = 5;
static const int BAR_GAP = 8;
static const int BAR_RADIUS = 4;

static const uint16_t BAT_BG_COLOR      = ILI9341_BLACK;
static const uint16_t BAT_OUTLINE_COLOR = ILI9341_WHITE;
static const uint16_t BAT_FILL_COLOR    = ILI9341_GREEN;

// ================= Internal helpers =================
void drawBatteryOutlineOnly() {
  tft.fillScreen(BAT_BG_COLOR);

  // Main battery body
  tft.drawRoundRect(BAT_X, BAT_Y, BAT_W, BAT_H, 8, BAT_OUTLINE_COLOR);
  tft.drawRoundRect(BAT_X + 1, BAT_Y + 1, BAT_W - 2, BAT_H - 2, 8, BAT_OUTLINE_COLOR);

  // Battery terminal
  int capX = BAT_X + BAT_W + CAP_GAP;
  int capY = BAT_Y + (BAT_H - CAP_H) / 2;
  tft.fillRoundRect(capX, capY, CAP_W, CAP_H, 3, BAT_OUTLINE_COLOR);
}

void drawFirstFourBarsOnce() {
  const int innerPadX = 12;
  const int innerPadY = 10;

  int innerX = BAT_X + innerPadX;
  int innerY = BAT_Y + innerPadY;
  int innerW = BAT_W - 2 * innerPadX;
  int innerH = BAT_H - 2 * innerPadY;

  int totalGap = BAR_GAP * (BAR_COUNT - 1);
  int barW = (innerW - totalGap) / BAR_COUNT;
  int barH = innerH;

  for (int i = 0; i < 4; i++) {
    int x = innerX + i * (barW + BAR_GAP);
    tft.drawRoundRect(x, innerY, barW, barH, BAR_RADIUS, BAT_OUTLINE_COLOR);
    tft.fillRoundRect(x, innerY, barW, barH, BAR_RADIUS, BAT_FILL_COLOR);
  }
}

void drawOnlyFifthBar(bool filled) {
  const int innerPadX = 12;
  const int innerPadY = 10;

  int innerX = BAT_X + innerPadX;
  int innerY = BAT_Y + innerPadY;
  int innerW = BAT_W - 2 * innerPadX;
  int innerH = BAT_H - 2 * innerPadY;

  int totalGap = BAR_GAP * (BAR_COUNT - 1);
  int barW = (innerW - totalGap) / BAR_COUNT;
  int barH = innerH;

  // 5th bar is index 4
  int i = 4;
  int x = innerX + i * (barW + BAR_GAP);

  // Clear only the 5th bar area
  tft.fillRect(x - 1, innerY - 1, barW + 2, barH + 2, BAT_BG_COLOR);

  // Draw the bar outline
  tft.drawRoundRect(x, innerY, barW, barH, BAR_RADIUS, BAT_OUTLINE_COLOR);

  // Fill only when at 5/5
  if (filled) {
    tft.fillRoundRect(x, innerY, barW, barH, BAR_RADIUS, BAT_FILL_COLOR);
  }
}

// ================= Functions called by Tripod.ino =================
void displaySetup() {
  tft.begin();
  tft.setRotation(3);

  batteryGraphicInitialized = false;
  fifthBarOn = true;

  drawBatteryOutlineOnly();
  drawFirstFourBarsOnce();
  drawOnlyFifthBar(true);

  batteryGraphicInitialized = true;
}

float calculateDisplayData() {
  return fifthBarOn ? 100.0f : 80.0f;
}

void updateDisplay() {
  if (!batteryGraphicInitialized) {
    drawBatteryOutlineOnly();
    drawFirstFourBarsOnce();
    drawOnlyFifthBar(true);
    batteryGraphicInitialized = true;
    return;
  }

  // Toggle between 5/5 and 4/5 every time loop calls this
  fifthBarOn = !fifthBarOn;

  unsigned long t0 = micros();
  drawOnlyFifthBar(fifthBarOn);
  unsigned long t1 = micros();

  Serial.print("5th bar refresh time (us): ");
  Serial.println(t1 - t0);
}