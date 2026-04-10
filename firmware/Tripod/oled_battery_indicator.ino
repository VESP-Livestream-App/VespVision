#include <Arduino.h>
#include <Wire.h>
#include <math.h>
#include <Adafruit_INA219.h>

#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>

// ================= TFT (ILI9341) =================
#define TFT_CS   10
#define TFT_DC    7
#define TFT_RST   8

Adafruit_ILI9341 tft(TFT_CS, TFT_DC, TFT_RST);

// ================= INA219 =================
Adafruit_INA219 ina219;

// ================= Battery / ADC =================
static const int   NUM_CELLS_SERIES = 2;
static const int   ADC_PIN = A7;
static const float ADC_VREF = 3.3f;

static const float R1 = 100000.0f;
static const float R2 = 47000.0f;
static const float PACK_CAPACITY_MAH = 2600.0f;
static const int CURRENT_SIGN = 1;
static const float REST_CURRENT_MA = 80.0f;
static const float REST_BLEND_ALPHA = 0.98f;

// ================= Temperature sensor on A6 =================
static const int TEMP_ADC_PIN = A6;
static const int TEMP_TABLE_SIZE = 22;

const float tempC_table[TEMP_TABLE_SIZE] = {
  10,11,12,13,14,15,16,17,18,19,
  20,21,22,23,24,25,26,27,28,29,
  30,40
};

const float tempV_table[TEMP_TABLE_SIZE] = {
  0.468750000f,
  0.489510490f,
  0.512195122f,
  0.532786885f,
  0.551724138f,
  0.573529412f,
  0.595744681f,
  0.617647059f,
  0.638297872f,
  0.691176471f,
  0.75f,
  0.78358209f,
  0.8203125f,
  0.853658537f,
  0.882352941f,
  0.913043478f,
  0.945945946f,
  0.981308411f,
  1.009615385f,
  1.060606061f,
  1.105263158f,
  1.544117647f
};

// ================= 60s voltage averaging =================
static const int NUM_SAMPLES = 60;
float vpack_buf[NUM_SAMPLES];
int   vpack_idx = 0;
bool  vpack_full = false;

// ================= LUT (per-cell OCV volts) =================
static const float ocv_soc_lut[] = {
  2.478484f, 2.548948f, 2.555629f, 2.636801f, 2.717973f, 2.795096f, 2.845899f, 2.896701f, 2.947503f, 2.979689f,
  3.009237f, 3.038785f, 3.062674f, 3.083212f, 3.103750f, 3.124092f, 3.144124f, 3.164156f, 3.183431f, 3.197409f,
  3.211386f, 3.225364f, 3.240896f, 3.256680f, 3.272465f, 3.284931f, 3.295543f, 3.306156f, 3.304352f, 3.317410f,
  3.331939f, 3.344696f, 3.356658f, 3.368619f, 3.380526f, 3.391995f, 3.403385f, 3.414583f, 3.421610f, 3.426887f,
  3.432164f, 3.436899f, 3.440721f, 3.444543f, 3.448370f, 3.452317f, 3.456320f, 3.460323f, 3.465373f, 3.470832f,
  3.476372f, 3.482455f, 3.488869f, 3.495323f, 3.501739f, 3.508092f, 3.514425f, 3.520623f, 3.526513f, 3.532403f,
  3.538241f, 3.543478f, 3.548635f, 3.553792f, 3.558754f, 3.563582f, 3.568411f, 3.573168f, 3.577760f, 3.582344f,
  3.586892f, 3.591139f, 3.595281f, 3.599423f, 3.603309f, 3.607144f, 3.610956f, 3.614661f, 3.618294f, 3.621917f,
  3.625508f, 3.629068f, 3.632628f, 3.636199f, 3.639814f, 3.643430f, 3.647046f, 3.650764f, 3.654502f, 3.658240f,
  3.662069f, 3.666019f, 3.669968f, 3.673983f, 3.678140f, 3.682339f, 3.686552f, 3.690932f, 3.695370f, 3.699882f,
  3.704528f, 3.709202f, 3.713828f, 3.718485f, 3.723182f, 3.727879f, 3.732598f, 3.737347f, 3.742095f, 3.746847f,
  3.751637f, 3.756426f, 3.761216f, 3.766030f, 3.770867f, 3.775704f, 3.780582f, 3.785519f, 3.790488f, 3.795490f,
  3.800562f, 3.805651f, 3.810753f, 3.815940f, 3.821127f, 3.826319f, 3.831529f, 3.836744f, 3.841952f, 3.847058f,
  3.852135f, 3.857211f, 3.862209f, 3.867022f, 3.871836f, 3.876640f, 3.881274f, 3.885880f, 3.890486f, 3.894997f,
  3.899466f, 3.903929f, 3.908409f, 3.912903f, 3.917498f, 3.922166f, 3.926984f, 3.931814f, 3.936749f, 3.941997f,
  3.947246f, 3.952528f, 3.958148f, 3.963841f, 3.969533f, 3.975359f, 3.981300f, 3.987241f, 3.993173f, 3.999034f,
  4.004879f, 4.010713f, 4.016239f, 4.021650f, 4.027055f, 4.032055f, 4.036909f, 4.041577f, 4.045854f, 4.049776f,
  4.053605f, 4.057009f, 4.059732f, 4.062456f, 4.065076f, 4.066936f, 4.068797f, 4.070658f, 4.072325f, 4.073932f,
  4.075540f, 4.077227f, 4.079082f, 4.080939f, 4.082910f, 4.085239f, 4.087742f, 4.090254f, 4.093629f, 4.097167f,
  4.100969f, 4.105953f, 4.111315f, 4.117198f, 4.124902f, 4.134033f, 4.143165f, 4.155217f, 4.171970f, 4.188723f,
  4.205476f
};
static const int LUT_SIZE = (int)(sizeof(ocv_soc_lut) / sizeof(ocv_soc_lut[0]));

// ================= Display state =================
static bool displayInitialized = false;
static float latest_soc_pct = 0.0f;
static float latest_tempC = 0.0f;
static float latest_vpack_avg = 0.0f;
static float latest_current_mA = 0.0f;
static float latest_soc_v_pct = 0.0f;
static float latest_tempV = 0.0f;
static float soc_cc = 0.50f;
static bool soc_initialized = false;
static char lastSocText[16] = "";
static char lastTempText[16] = "";

// ================= Helpers =================
static inline float clamp01(float x) {
  if (x < 0.0f) return 0.0f;
  if (x > 1.0f) return 1.0f;
  return x;
}

float readADCVoltage_V(int pin) {
  const int samples = 16;

  analogRead(pin);
  delayMicroseconds(300);

  uint32_t acc = 0;
  for (int i = 0; i < samples; i++) {
    acc += analogRead(pin);
    delayMicroseconds(300);
  }

  float raw = acc / (float)samples;
  return (raw / 4095.0f) * ADC_VREF;
}

float readPackVoltage_V() {
  const int samples = 16;
  uint32_t acc = 0;
  for (int i = 0; i < samples; i++) {
    acc += analogRead(ADC_PIN);
    delayMicroseconds(200);
  }

  float raw = acc / (float)samples;
  float v_adc = (raw / 4095.0f) * ADC_VREF;
  return v_adc * (R1 + R2) / R2;
}

float averageVpack() {
  int count = vpack_full ? NUM_SAMPLES : vpack_idx;
  if (count <= 0) return 0.0f;

  float sum = 0.0f;
  for (int i = 0; i < count; i++) {
    sum += vpack_buf[i];
  }
  return sum / (float)count;
}

float socFromCellVoltage(float v_cell) {
  if (v_cell <= ocv_soc_lut[0]) return 0.0f;
  if (v_cell >= ocv_soc_lut[LUT_SIZE - 1]) return 100.0f;

  int lo = 0;
  int hi = LUT_SIZE - 1;
  while (hi - lo > 1) {
    int mid = (lo + hi) / 2;
    if (ocv_soc_lut[mid] <= v_cell) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  float v0 = ocv_soc_lut[lo];
  float v1 = ocv_soc_lut[lo + 1];
  float t = (v_cell - v0) / (v1 - v0);
  float soc0 = lo * 0.5f;
  return soc0 + t * 0.5f;
}

float temperatureFromVoltage(float v) {
  if (v <= tempV_table[0]) return tempC_table[0];
  if (v >= tempV_table[TEMP_TABLE_SIZE - 1]) return tempC_table[TEMP_TABLE_SIZE - 1];

  for (int i = 0; i < TEMP_TABLE_SIZE - 1; i++) {
    float v0 = tempV_table[i];
    float v1 = tempV_table[i + 1];
    if (v >= v0 && v <= v1) {
      float t = (v - v0) / (v1 - v0);
      return tempC_table[i] + t * (tempC_table[i + 1] - tempC_table[i]);
    }
  }

  return -999.0f;
}

static void drawStaticLayout() {
  tft.fillScreen(ILI9341_BLACK);

  tft.setTextColor(ILI9341_WHITE);
  tft.setTextSize(2);

  tft.setCursor(10, 18);
  tft.print("Tripod Status");

  tft.setCursor(10, 70);
  tft.print("SOC");

  tft.setCursor(10, 130);
  tft.print("TEMP");

  tft.drawFastHLine(10, 45, 300, ILI9341_DARKGREY);
  tft.drawFastHLine(10, 105, 300, ILI9341_DARKGREY);

  tft.drawRect(108, 64, 110, 24, ILI9341_DARKGREY);
  tft.drawRect(108, 124, 110, 24, ILI9341_DARKGREY);
}

static void drawValueField(int x, int y, int w, int h, const char *valueText, uint16_t textColor) {
  tft.fillRect(x, y, w, h, ILI9341_BLACK);
  tft.setTextColor(textColor);
  tft.setTextSize(2);
  tft.setCursor(x, y);
  tft.print(valueText);
}

// ================= Functions called by Tripod.ino =================
void displaySetup() {
  analogReadResolution(12);

  Wire.begin();
  if (!ina219.begin()) {
    Serial.println("INA219 not found!");
    while (1) delay(100);
  }

  tft.begin();
  tft.setRotation(3);

  for (int i = 0; i < NUM_SAMPLES; i++) {
    vpack_buf[i] = 0.0f;
  }

  displayInitialized = false;
  drawStaticLayout();
  displayInitialized = true;
}

float calculateDisplayData() {
  float current_mA_raw = ina219.getCurrent_mA();
  float current_mA = CURRENT_SIGN * current_mA_raw;

  float vpack = readPackVoltage_V();
  float tempV = readADCVoltage_V(TEMP_ADC_PIN);
  float tempC = temperatureFromVoltage(tempV);

  vpack_buf[vpack_idx] = vpack;
  vpack_idx++;
  if (vpack_idx >= NUM_SAMPLES) {
    vpack_idx = 0;
    vpack_full = true;
  }

  float vpack_avg = averageVpack();
  float vcell_avg = vpack_avg / (float)NUM_CELLS_SERIES;

  float soc_v_pct = socFromCellVoltage(vcell_avg);
  float soc_v = soc_v_pct / 100.0f;

  if (!soc_initialized && (vpack_full || vpack_idx >= 10)) {
    soc_cc = clamp01(soc_v);
    soc_initialized = true;
  }

  float delta_mAh = (current_mA * 1.0f) / 3600.0f;
  soc_cc -= (delta_mAh / PACK_CAPACITY_MAH);
  soc_cc = clamp01(soc_cc);

  if (fabs(current_mA) < REST_CURRENT_MA) {
    soc_cc = clamp01(REST_BLEND_ALPHA * soc_cc + (1.0f - REST_BLEND_ALPHA) * soc_v);
  }

  latest_soc_pct = soc_cc * 100.0f;
  latest_vpack_avg = vpack_avg;
  latest_current_mA = current_mA;
  latest_soc_v_pct = soc_v_pct;
  latest_tempV = tempV;
  latest_tempC = tempC;

  return latest_soc_pct;
}

void updateDisplay() {
  if (!displayInitialized) {
    drawStaticLayout();
    displayInitialized = true;
  }

  char socText[16];
  char tempText[16];

  snprintf(socText, sizeof(socText), "%.1f%%", latest_soc_pct);
  snprintf(tempText, sizeof(tempText), "%.1f C", latest_tempC);

  if (strcmp(socText, lastSocText) != 0) {
    drawValueField(110, 68, 100, 16, socText, ILI9341_GREEN);
    strncpy(lastSocText, socText, sizeof(lastSocText));
    lastSocText[sizeof(lastSocText) - 1] = '\0';
  }

  if (strcmp(tempText, lastTempText) != 0) {
    drawValueField(110, 128, 100, 16, tempText, ILI9341_CYAN);
    strncpy(lastTempText, tempText, sizeof(lastTempText));
    lastTempText[sizeof(lastTempText) - 1] = '\0';
  }
}
