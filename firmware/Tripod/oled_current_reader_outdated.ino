#include <Wire.h>
#include <Adafruit_INA219.h>

#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>

// ---- TFT pin config (change if you wired differently) ----
#define TFT_CS   10
#define TFT_DC   7
#define TFT_RST   -1

Adafruit_ILI9341 tft(TFT_CS, TFT_DC, TFT_RST);
Adafruit_INA219 ina219;

// ---- Current history buffer ----
static const int N = 80;              // number of points on graph
float hist_mA[N];
int hist_idx = 0;
bool hist_full = false;

// Graph area
static const int GX = 10;
static const int GY = 90;
static const int GW = 300;
static const int GH = 140;

// Range for graph autoscaling (simple)
float min_mA = -500.0f;
float max_mA =  500.0f;

void drawStaticUI() {
  tft.fillScreen(ILI9341_BLACK);

  tft.setTextColor(ILI9341_WHITE);
  tft.setTextSize(2);
  tft.setCursor(10, 10);
  tft.print("INA219 Current");

  tft.setTextSize(2);
  tft.setCursor(10, 40);
  tft.print("Now: ");
  tft.setCursor(10, 65);
  tft.print("Prev:");

  // Graph border
  tft.drawRect(GX - 1, GY - 1, GW + 2, GH + 2, ILI9341_DARKGREY);

  // Labels
  tft.setTextSize(1);
  tft.setCursor(GX, GY + GH + 8);
  tft.print("History");
}

int yFrommA(float mA) {
  // Clamp and map to graph coordinates (top=GY, bottom=GY+GH-1)
  if (mA < min_mA) mA = min_mA;
  if (mA > max_mA) mA = max_mA;

  float norm = (mA - min_mA) / (max_mA - min_mA); // 0..1
  int y = GY + (GH - 1) - (int)(norm * (GH - 1));
  return y;
}

void redrawGraph() {
  // Clear graph area
  tft.fillRect(GX, GY, GW, GH, ILI9341_BLACK);

  // Midline at 0 mA if in range
  if (min_mA < 0 && max_mA > 0) {
    int y0 = yFrommA(0);
    tft.drawFastHLine(GX, y0, GW, ILI9341_DARKGREY);
  }

  // Determine how many points we have
  int count = hist_full ? N : hist_idx;
  if (count < 2) return;

  // Plot line
  // Oldest -> newest across width
  for (int i = 1; i < count; i++) {
    int idx0 = (hist_full ? (hist_idx + i - 1) : (i - 1)) % N;
    int idx1 = (hist_full ? (hist_idx + i)     : (i))     % N;

    float a = hist_mA[idx0];
    float b = hist_mA[idx1];

    int x0 = GX + (int)((i - 1) * (GW - 1) / (float)(count - 1));
    int x1 = GX + (int)(i       * (GW - 1) / (float)(count - 1));
    int y0 = yFrommA(a);
    int y1 = yFrommA(b);

    tft.drawLine(x0, y0, x1, y1, ILI9341_CYAN);
  }
}

void printValueLine(int x, int y, float mA) {
  // Overwrite old value area (fixed width)
  tft.fillRect(x, y, 220, 20, ILI9341_BLACK);
  tft.setCursor(x, y);
  tft.setTextSize(2);
  tft.setTextColor(ILI9341_WHITE);

  tft.print(mA, 1);
  tft.print(" mA");
}

void setup() {
  Serial.begin(115200);
  while (!Serial) { delay(10); }

  Wire.begin();

  if (!ina219.begin()) {
    Serial.println("INA219 not found. Check SDA/SCL/VCC(3.3V)/GND.");
    while (1) delay(100);
  }

  // Pick ONE calibration if desired (optional):
  // ina219.setCalibration_32V_2A();
  // ina219.setCalibration_32V_1A();
  // ina219.setCalibration_16V_400mA();

  tft.begin();
  tft.setRotation(3); // landscape; try 0/1/2/3 if needed
  drawStaticUI();

  // init history
  for (int i = 0; i < N; i++) hist_mA[i] = 0;
}

void loop() {
  static float prev_mA = 0.0f;

  float current_mA = ina219.getCurrent_mA();

  // Store history (ring buffer)
  hist_mA[hist_idx] = current_mA;
  hist_idx++;
  if (hist_idx >= N) {
    hist_idx = 0;
    hist_full = true;
  }

  // Update numeric display
  printValueLine(70, 40, current_mA);
  printValueLine(70, 65, prev_mA);

  // Redraw graph occasionally (every sample here; you can throttle if you want)
  redrawGraph();

  prev_mA = current_mA;
  delay(250);
}