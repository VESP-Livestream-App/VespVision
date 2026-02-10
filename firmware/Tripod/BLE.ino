#include <ArduinoBLE.h>

#define SERVICE_UUID        "499d163b-be72-4691-a8af-61657909ac11"
#define DEVICE_NAME "BBallTripod"
#define SERVO_COMMAND_UUID    "b793f920-016e-49ea-a4fd-15fe1d21a1a5"
#define CURRENT_POS_UUID "d69abf56-23cb-4101-a496-f7f0869130ef"

BLEService nanoService(SERVICE_UUID);
BLECharacteristic servoCommand(SERVO_COMMAND_UUID, BLERead | BLEWrite | BLENotify, sizeof(moveCmd_u));
BLECharacteristic currentPos(CURRENT_POS_UUID, BLERead | BLEWrite | BLENotify, sizeof(int));

extern moveCmd_u moveCmd;

void bleSetup()
{
    if (!BLE.begin()) {
    Serial.println("Starting BLE failed!");
    while (1);
  }

  BLE.setLocalName(DEVICE_NAME);
  BLE.setAdvertisedService(nanoService);

  nanoService.addCharacteristic(servoCommand);
  nanoService.addCharacteristic(currentPos);
  BLE.addService(nanoService);

  BLE.advertise();
  Serial.println("BLE device active & advertising...");
}

bool checkNewCmd()
{
  if (servoCommand.written()) 
  {
    servoCommand.readValue(moveCmd.bytes, sizeof(moveCmd));

    Serial.print("Received angle: ");
    Serial.print(moveCmd.cmd.angle);
    Serial.print(" time: ");
    Serial.println(moveCmd.cmd.time);
    return true;
  }
  return false;
}

void servoAngleBroadcast(int32_t angle)
{
    currentPos.writeValue(angle);
}