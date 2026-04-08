import { Directory, File, Paths } from 'expo-file-system';

const CSV_HEADER = 'timestamp_iso,detected_ball_angle_deg,servo_command_angle_deg\n';
const csvDir = new Directory(Paths.document, 'telemetry');
const csvFile = new File(csvDir, 'pid_tuning.csv');

let initialized = false;
let hasLoggedPath = false;

const ensureCsvFile = async (): Promise<void> => {
  if (initialized) {
    return;
  }
  if (!csvDir.exists) {
    csvDir.create({ idempotent: true, intermediates: true });
  }
  if (!csvFile.exists) {
    csvFile.create({ intermediates: true, overwrite: false });
    csvFile.write(CSV_HEADER);
  }
  initialized = true;
  if (!hasLoggedPath) {
    hasLoggedPath = true;
    console.log(`📄 PID telemetry CSV: ${csvFile.uri}`);
  }
};

const ensureCsvHeader = async (): Promise<void> => {
  await ensureCsvFile();
  const content = await csvFile.text();
  if (content.startsWith(CSV_HEADER)) {
    return;
  }
  csvFile.write(`${CSV_HEADER}${content}`);
};

export const appendPidTelemetryRow = async (
  detectedBallAngleDeg: number | null,
  servoCommandAngleDeg: number | null
): Promise<void> => {
  await ensureCsvHeader();
  const detectedAngleText = detectedBallAngleDeg === null ? '' : detectedBallAngleDeg.toFixed(3);
  const servoAngleText = servoCommandAngleDeg === null ? '' : servoCommandAngleDeg.toFixed(3);
  const row = `${new Date().toISOString()},${detectedAngleText},${servoAngleText}\n`;
  const existing = await csvFile.text();
  csvFile.write(`${existing}${row}`);
};

export const getPidTelemetryCsvPath = (): string => csvFile.uri;

export const preparePidTelemetryCsvForExport = async (): Promise<string> => {
  await ensureCsvHeader();
  return csvFile.uri;
};
