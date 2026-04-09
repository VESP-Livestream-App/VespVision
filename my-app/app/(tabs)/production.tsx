import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';

export default function ProductionTabScreen() {
  const router = useRouter();

  return (
    <ThemedView style={styles.container}>
      <View style={styles.content}>
        <ThemedText style={styles.title}>Welcome to Vesp.</ThemedText>
        <Pressable onPress={() => router.push('/camera-stream')} android_ripple={{ color: 'rgba(255,255,255,0.2)' }}>
          <ThemedView style={styles.button}>
            <ThemedText style={styles.buttonText}>Stream</ThemedText>
          </ThemedView>
        </Pressable>
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  content: {
    width: '100%',
    alignItems: 'center',
    gap: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
  },
  button: {
    marginTop: 8,
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 10,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
  },
  buttonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
});
