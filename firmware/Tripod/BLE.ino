#include <ArduinoBLE.h>

#define SERVICE_UUID        "499d163b-be72-4691-a8af-61657909ac11"
#define DEVICE_NAME "BBallTripod"
#define SERVO_COMMAND_UUID    "b793f920-016e-49ea-a4fd-15fe1d21a1a5"
#define CURRENT_POS_UUID "d69abf56-23cb-4101-a496-f7f0869130ef"
#define SOC_UUID "f2f8b45c-3f57-4e7a-9185-5f2f4b0d8f42"

BLEService nanoService(SERVICE_UUID);

BLECharacteristic servoCommand(SERVO_COMMAND_UUID, BLEWriteWithoutResponse, sizeof(moveCmd_u));
BLECharacteristic currentPos(CURRENT_POS_UUID, BLERead | BLENotify, sizeof(int32_t));
BLECharacteristic soc(SOC_UUID, BLERead | BLENotify, sizeof(uint32_t));

extern moveCmd_u moveCmd;
volatile bool newCmdReady = false;

void onServoCommand(BLEDevice central, BLECharacteristic characteristic) {
  if (servoCommand.valueLength() == sizeof(moveCmd_u)) {
    servoCommand.readValue(moveCmd.bytes, sizeof(moveCmd_u));
    newCmdReady = true;
  }
}

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
  //nanoService.addCharacteristic(soc);
  servoCommand.setEventHandler(BLEWritten, onServoCommand);
  BLE.addService(nanoService);

  BLE.advertise();
  Serial.println("BLE device active & advertising...");
}

void servoAngleBroadcast(int32_t angle)
{
    currentPos.writeValue(angle);
}

void tripodSocBroadcast(float tripodSoc)
{
    // ArduinoBLE has no float overload; send float as 4 raw bytes.
    soc.writeValue(uint32_t(tripodSoc), sizeof(tripodSoc));
}
