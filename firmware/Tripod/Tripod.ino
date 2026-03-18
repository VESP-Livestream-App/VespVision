#include <ArduinoBLE.h>

typedef struct __attribute__((packed))
{
    int angle;
    unsigned long time;
} moveCmd_t;

typedef union 
{
  moveCmd_t cmd;
  uint8_t bytes[sizeof(moveCmd_t)];
} moveCmd_u;

moveCmd_u moveCmd = 
{
  .cmd = {
    .angle = 0,
    .time = 1000
  }
};

BLEDevice central;
// static unsigned long lastSampleMs = 0;
// static unsigned long lastDisplayMs = 0;

// forward declarations
void setServo(int angle, unsigned long durationMs);
void updateServo();

void setup() 
{
  Serial.begin(115200);
  bleSetup();
  servoSetup();
  // displaySetup();
}


void loop() {
  BLE.poll();  

  // Check for new connection
  if (!central) {
    central = BLE.central();
    if (central) {
      Serial.print("Connected to ");
      Serial.println(central.address());
    }
  }
  
  // unsigned long now = millis();
  // float soc_pct = -1.0f;

  // if (now - lastSampleMs >= 1000) 
  // {
  //   lastSampleMs += 1000;
  //   soc_pct = calculateDisplayData();
  // }

  // if (now - lastDisplayMs >= 1000) 
  // {
  //   lastDisplayMs += 1000;
  //   updateDisplay();
  // }
  
  // If connected, handle commands
  if (central && central.connected()) 
  {
    if (checkNewCmd()) 
    {
      adjustServo(moveCmd.cmd.angle, moveCmd.cmd.time);
    }

    updateServo();
    int servoAngle = getServoAngle();
    servoAngleBroadcast(servoAngle);
    // if (soc_pct >= 0.0f && soc_pct <= 100.0f) {
    //   tripodSocBroadcast(soc_pct);
    // }
    // else {
    //   Serial.println("SOC out of range, not broadcasting");
    // }
  } 
  else if (central) 
  {
    Serial.println("Disconnected");
    central = BLEDevice();   // reset state for next connection
  }
}
