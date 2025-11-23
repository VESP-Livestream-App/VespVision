// TestServoPanel.tsx
import React, { useState } from 'react';
import { View, Text, Button, StyleSheet } from 'react-native';
import Slider from '@react-native-community/slider';
import { Buffer } from 'buffer';

export function TestServoPanel({ device, SERVICE_UUID, CHAR_UUID }) {
  const [angle, setAngle] = useState(90);
  const [timeMs, setTimeMs] = useState(1000);

  const sendPacket = async () => {
    const a = Math.round(angle);
    const t = Math.round(timeMs);

    const payload = [
      a,
      t & 0xff,
      (t >> 8) & 0xff,
    ];

    const base64Payload = Buffer.from(payload).toString('base64');

    try {
      await device.writeCharacteristicWithResponseForService(
        SERVICE_UUID,
        CHAR_UUID,
        base64Payload
      );
      console.log('Sent:', payload);
    } catch (e) {
      console.log('BLE error:', e);
    }
  };

  return (
    <View style={styles.panel}>
      <Text style={styles.label}>Angle: {angle}°</Text>
      <Slider
        minimumValue={0}
        maximumValue={180}
        step={1}
        value={angle}
        onValueChange={setAngle}
      />

      <Text style={styles.label}>Time: {timeMs} ms</Text>
      <Slider
        minimumValue={100}
        maximumValue={5000}
        step={50}
        value={timeMs}
        onValueChange={setTimeMs}
      />

      <Button title="Send" onPress={sendPacket} />
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    bottom: 30,
    left: 20,
    right: 20,
    padding: 20,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  label: {
    color: 'white',
    marginBottom: 10,
    fontSize: 16,
  },
});
