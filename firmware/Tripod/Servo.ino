#include <Servo.h>

Servo mgs90;

// movement state
static int startAngle = 0;
static int targetAngle = 0;
static unsigned long startTime = 0;
static unsigned long moveDuration = 0;
static bool isMoving = false;

void servoSetup()
{
    mgs90.attach(9);
}

void adjustServo(int angle, unsigned long durationMs) 
{
  startAngle = mgs90.read();
  Serial.println(startAngle);
  targetAngle = constrain(startAngle + angle, 0, 180);

  if (durationMs < 20) durationMs = 20;
  moveDuration = durationMs;

  startTime = millis();
  isMoving = true;
}

void setServo(int angle, unsigned long durationMs) 
{
  startAngle = mgs90.read();
  targetAngle = constrain(angle, 0, 180);

  if (durationMs < 20) durationMs = 20;
  moveDuration = durationMs;

  startTime = millis();
  isMoving = true;
}

void updateServo() 
{
  if (!isMoving) return;

  unsigned long elapsed = millis() - startTime;
  if (elapsed >= moveDuration) {
    mgs90.write(targetAngle);
    isMoving = false;
    return;
  }

  float progress = (float)elapsed / (float)moveDuration;
  if (progress > 1.0) progress = 1.0;

  int currentAngle = startAngle + (targetAngle - startAngle) * progress;
  mgs90.write(currentAngle);
}

int getServoAngle()
{
  return mgs90.read();
}

