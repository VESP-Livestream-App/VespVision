from fileinput import filename
import numpy as np
import random
import time
from colorama import init, Fore, Style
import logging
import threading
import os
import csv
import sys

PLANE_DEGREES = 180
X_PIXELS = 640
TICK_FREQ = 25 # Hz
TARGET_MOV_SCALE = 2
TICK_LENGTH = 1.0 / TICK_FREQ
MOVEMENT_MAG_UPPER = 40 # degrees of potential movement per update (random number is used)
EDGE_VIEW_REDUNDANCY_FACTOR = 1.0 / 4.0 # Fraction of how much extra FOV to give when target is near edge 
GAIN_FACTOR = 25.0
SERVO_SPEED = 60.0 # degrees per second
DATA_HEADERS = ['Total Time [s]', 'Searching Time [s]', 'Tracking Time [s]', 
                            'Number of Searching Intervals', 'Number of Tracking Intervals',
                            'Longest Searching Time [s]', 'Longest Tracking Time [s]', 
                            'Movement Magnitude Upper-Bound [Degrees]','Controller Gain', 'Servo Speed [Degrees/s]', 
                            'Field of View [Degrees]', 'Tick Rate [s]', 'Controller Rate [Hz]']

x_plane = range(0, PLANE_DEGREES)
x_pixels = range(0, X_PIXELS, 1)
target_box = len(x_plane) // 2
field_of_view = 70 # degrees
controller_rate = 3 # Hz
display_rate = 1 # Hz
next_pos = target_box

class Servo:
    def __init__ (self, initial_pos=90.0, speed=60.0):
        self._pos = initial_pos
        self.target_pos = initial_pos
        self.speed = speed # degrees per second
        self.running = True
        self.lock = threading.Lock()
        self.searching = False
        
        self.thread = threading.Thread(target=self._update_loop, daemon=True)
        self.thread.start()
    
    @property
    def pos(self):
        with self.lock:
            return self._pos
    
    def move_to(self, position: float):
        self.searching = False
        if position < 0.0 or position > 180.0:
            logging.error("Position must be between 0 and 180 degrees.")
        
        # Clamp value
        position = max(0.0, min(180.0, position))
        
        with self.lock:
            self.target_pos = position

    def search_target(self, direction: int):
        start_angle = 0 + field_of_view * EDGE_VIEW_REDUNDANCY_FACTOR if direction > 0 else 180 - field_of_view * EDGE_VIEW_REDUNDANCY_FACTOR
        self.searching = True
        with self.lock:
            self.target_pos = start_angle


    def _update_loop(self):
        last_time = time.time()
        while self.running:
            current_time = time.time()
            dt = current_time - last_time
            last_time = current_time
            
            with self.lock:
                if self._pos < self.target_pos:
                    self._pos = min(self.target_pos, self._pos + self.speed * dt)
                elif self._pos > self.target_pos:
                    self._pos = max(self.target_pos, self._pos - self.speed * dt)
                if self.searching:
                    if self._pos <= 0.0 + field_of_view // 4:
                        self.target_pos = 180.0 - field_of_view // 4
                    elif self._pos >= 180.0 - field_of_view // 4:
                        self.target_pos = 0.0 + field_of_view // 4
            sleep_ticks = TICK_LENGTH - (time.time() - last_time)
            if sleep_ticks < 0:
                logging.warning(f"Servo update loop is taking too long! Overran tick by {-sleep_ticks:.4f} seconds.")
            time.sleep(sleep_ticks) 

class SimpleController:
    def __init__(self, gain: float):
        self.gain = gain

    def compute_control(self, error: float) -> float:
        return self.gain * error
    
def get_captured_window_indices(x_plane, center_angle, field_of_view):
    center_idx = int(center_angle)
    start_index = max(center_idx - field_of_view // 2, 0)
    end_index = min(center_idx + field_of_view // 2, len(x_plane) )
    return range(start_index, end_index)

def angle_to_pixels(angle):
    # Maps 0-180 degrees to 0-640 pixels
    return int((angle / field_of_view) * X_PIXELS)

def display_captured_window(servo_pos_angle):
    servo_idx = int(servo_pos_angle)
    # Define the visible range based on the servo
    visible_indices = get_captured_window_indices(x_plane, servo_pos_angle, field_of_view)
    
    captured_window_str = ''
    for i in range(len(x_plane)):
        char = '.'
        
        # Mark the physical target location in the world
        if i == target_box:
            char = Fore.RED + '|' + Style.RESET_ALL
        
        # If this point in the world is visible to the servo
        if i in visible_indices:
            # If we are looking at the target, combine them (Yellow maybe, or just keep Red)
            if i == target_box:
                 char = Fore.YELLOW + '|' + Style.RESET_ALL 
            else:
                 char = Fore.GREEN + '*' + Style.RESET_ALL # Represents "seeing" empty space
        
        captured_window_str += char
    print(captured_window_str)

def update_goal_location():
    global target_box, next_pos
    max_idx = len(x_plane) - 1
    
    if target_box == next_pos:
        next_pos = random.randint(max(target_box - MOVEMENT_MAG_UPPER, 0), min(target_box + MOVEMENT_MAG_UPPER, max_idx))
    elif target_box < next_pos:
        if target_box + 1 * TARGET_MOV_SCALE > max_idx or target_box + 1 * TARGET_MOV_SCALE > next_pos:
            target_box = next_pos
        else:
            target_box += 1* TARGET_MOV_SCALE
    else:
        if target_box - 1 * TARGET_MOV_SCALE < 0 or target_box - 1 * TARGET_MOV_SCALE < next_pos:
            target_box = next_pos
        else:
            target_box -= 1* TARGET_MOV_SCALE

def write_data_to_csv(total_time, searching_time, tracking_time, 
                      number_of_searching_intervals, number_of_tracking_intervals,
                      longest_searching_time, longest_tracking_time):
    filename = f"ctrl_sim_linear_plane{PLANE_DEGREES}_pixels{X_PIXELS}.csv"
    os.makedirs("test", exist_ok=True)
    filepath = os.path.join("test", filename)
    rows_to_write = []
    if os.path.exists(filepath) == False:
        rows_to_write.append(DATA_HEADERS)
    rows_to_write.append([total_time, searching_time, tracking_time, 
                         number_of_searching_intervals, number_of_tracking_intervals,
                         longest_searching_time, longest_tracking_time,
                         MOVEMENT_MAG_UPPER, GAIN_FACTOR, SERVO_SPEED,
                         field_of_view, TICK_FREQ, controller_rate])
    with open(filepath, mode='a', newline='') as file:
        writer = csv.writer(file)
        writer.writerows(rows_to_write)
    
    

def main():
    global GAIN_FACTOR
    for GAIN_FACTOR in range(15.0, 40.0, 5):
        controller = SimpleController(gain=GAIN_FACTOR)
        init(autoreset=True)
        start_time = time.time()
        current_time = start_time
        servo = Servo(initial_pos=90.0, speed=SERVO_SPEED)
        interval_start_time = time.time()
        searching_time = 0.0
        tracking_time = 0.0
        longest_searching_time = 0.0
        number_of_searching_intervals = 0
        longest_tracking_time = 0.0
        number_of_tracking_intervals = 0
        for _ in range(10000):
            loop_start_time = time.time()
            elapsed_time = time.time() - current_time
            
            # 1. Update the world (target moves)
            update_goal_location()
            
            if elapsed_time >= 1.0 / controller_rate:
                # 2. Sensor Step: What does the camera see?
                # The camera is centered at servo.pos
                servo_pos = servo.pos
                visible_indices = get_captured_window_indices(x_plane, servo_pos, field_of_view)
                
                # Check if target is visible
                if target_box in visible_indices:
                    if servo.searching or number_of_searching_intervals == 0:
                        searching_interval_length = time.time() - interval_start_time
                        if searching_interval_length > longest_searching_time:
                            longest_searching_time = searching_interval_length
                        number_of_searching_intervals += 1
                        searching_time += searching_interval_length
                        interval_start_time = time.time()

                    # 3. Error Calculation
                    # Visual Servoing: Error is distance from center of image
                    # Center of image = servo_pos
                    # Target location = target_box
                    # Error = Target - Center
                    
                    error_degrees = target_box - servo_pos
                    
                    # Normalize error to -1.0 to 1.0 range based on half-FOV (max error possible while visible)
                    # If error is +35 degrees (half FOV), normalized error is 1.0
                    normalized_error = error_degrees / (field_of_view / 2)
                    
                    # 4. Controller Step
                    control_signal = controller.compute_control(normalized_error)
                    
                    # 5. Actuator Step (Update Target Position)
                    # For a position servo, we want to move TO the target
                    # New Angle = Current Angle + Correction
                    # If error is positive (target is to the right), we need to add to angle.
                    
                    # Scale control signal to degrees (e.g. if signal is 1.0, move 10 degrees?)
                    # Simple P-controller outputting "speed" or "displacement"? 
                    # Let's say output is displacement in degrees.
                    displacement = control_signal * 1.0 # Gain scaler
                    
                    new_servo_target = servo_pos + displacement
                    servo.move_to(new_servo_target)
                    
                elif not servo.searching:
                    tracking_interval_length = time.time() - interval_start_time
                    if tracking_interval_length > longest_tracking_time:
                        longest_tracking_time = tracking_interval_length
                    number_of_tracking_intervals += 1
                    tracking_time += tracking_interval_length
                    interval_start_time = time.time()
                    logging.warning(f"Target lost! Target at {target_box}, Camera at {int(servo_pos)}")
                    search_direction = 1 if (error_degrees < 0) else -1
                    servo.search_target(search_direction)
                
                current_time = time.time()
            
            if int(time.time() * 10) % 5 == 0: 
                display_captured_window(servo.pos)
            sleep_ticks = TICK_LENGTH - (time.time() - loop_start_time)
            if sleep_ticks < 0:
                logging.warning(f"Main loop is taking too long! Overran tick by {-sleep_ticks:.4f} seconds.")
            time.sleep(sleep_ticks)  # Maintain tick rate

        total_time = time.time() - start_time
        if servo.searching:
            searching_interval_length = time.time() - interval_start_time
            if searching_interval_length > longest_searching_time:
                longest_searching_time = searching_interval_length
            number_of_searching_intervals += 1
            searching_time += searching_interval_length
        else:
            tracking_interval_length = time.time() - interval_start_time
            if tracking_interval_length > longest_tracking_time:
                longest_tracking_time = tracking_interval_length
            number_of_tracking_intervals += 1
            tracking_time += tracking_interval_length
        write_data_to_csv(total_time, searching_time, tracking_time, 
                        number_of_searching_intervals, number_of_tracking_intervals,
                        longest_searching_time, longest_tracking_time)
if __name__ == "__main__":
    main()