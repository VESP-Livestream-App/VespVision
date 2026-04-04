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
extern volatile bool newCmdReady;

// forward declarations
void setServo(int angle, unsigned long durationMs);
void updateServo();

void setup() 
{
  Serial.begin(115200);
  bleSetup();
  servoSetup();
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

  // If connected, handle commands
  if (central && central.connected()) 
  {
    if (newCmdReady) 
    {
      newCmdReady = false;
      adjustServo(moveCmd.cmd.angle, moveCmd.cmd.time);
    }

    updateServo();
    int servoAngle = getServoAngle();
    servoAngleBroadcast(servoAngle);
  } 
  else if (central) 
  {
    Serial.println("Disconnected");
    central = BLEDevice();   // reset state for next connection
  }
}
