"""Shared wire protocol between the ESP32 firmware and this backend.

Kept in one place so the 20-byte upstream sample and the 8-byte downstream
control packet are defined (and tested) exactly once. Must stay in sync with
the ESP32 firmware (see main/app_main.c) and TASK.md.
"""
from __future__ import annotations

import struct

# --- Upstream sample: ESP32 -> host, fixed 20 bytes (little-endian) --------
# AA 55 | u64 timestamp_ms | f32 voltage(V) | f32 current(mA) | u16 checksum
# checksum = sum of the first 18 bytes & 0xFFFF
SAMPLE_FORMAT = "<2sQffH"
SAMPLE_SIZE = struct.calcsize(SAMPLE_FORMAT)          # 20
SAMPLE_HEADER = b"\xaa\x55"
SAMPLE_CKSUM_OFFSET = SAMPLE_SIZE - 2                 # checksum is the last 2 bytes
CKSUM_OFFSET = SAMPLE_CKSUM_OFFSET                     # alias

# --- Upstream device-info: ESP32 -> host, fixed 37 bytes (little-endian) ---
# Sent once per (re)connect, before the sample stream. Carries the running
# app's version string and which OTA slot it is running from, so the dashboard
# can show the current firmware + active slot.
#   AA 53 | 32s version (null-padded) | u8 slot | u16 checksum
#   slot   = running OTA slot index the firmware normalizes from the partition
#            subtype: 0 (unknown), 1 (ota_0), 2 (ota_1). (ESP-IDF's raw OTA
#            subtypes are 0x10/0x11; the firmware subtracts the base before
#            sending so this byte stays small and stable.)
# checksum = sum of the first 35 bytes (header + version + slot) & 0xFFFF
INFO_FORMAT = "<2s32sBH"
INFO_SIZE = struct.calcsize(INFO_FORMAT)              # 37
INFO_HEADER = b"\xaa\x53"
INFO_CKSUM_OFFSET = INFO_SIZE - 2                     # 35
OTA_SLOT_UNKNOWN = 0
OTA_SLOT_0 = 1
OTA_SLOT_1 = 2

# --- Upstream OCP event: ESP32 -> host, fixed 25 bytes (little-endian) ------
# Sent by the device when its INA226 ALERT pin asserts (shunt overcurrent).
# Carries a fresh voltage/current/power read taken at the edge.
#   AA 54 | u8 type | u64 timestamp_ms | f32 voltage(V) | f32 current(mA)
#         | f32 power(mW) | u16 checksum (over the first 23 bytes)
EVENT_FORMAT = "<2sBQfffH"
EVENT_SIZE = struct.calcsize(EVENT_FORMAT)            # 25
EVENT_HEADER = b"\xaa\x54"
EVENT_CKSUM_OFFSET = EVENT_SIZE - 2                   # 23
EVENT_TYPE_SHUNT_OCP = 0x01

# --- Downstream control: host -> ESP32, fixed 8 bytes (little-endian) ------
# BB 66 | u8 cmd | u8 len | u16 payload | u16 checksum
# checksum = sum of the first 6 bytes & 0xFFFF
#   cmd=0x01  set sampling interval (payload = interval_ms)
#   cmd=0x02  start OTA update      (payload unused, sent as 0)
CONTROL_FORMAT = "<BBBBHH"
CONTROL_SIZE = struct.calcsize(CONTROL_FORMAT)        # 8
CONTROL_HEADER = b"\xbb\x66"
CMD_SET_INTERVAL = 0x01
CMD_START_OTA = 0x02
PAYLOAD_LEN_INTERVAL = 0x02

INTERVAL_FAST_MS = 100          # 10 Hz  (viewers present)
INTERVAL_SLOW_MS = 10000        # 0.1 Hz (no viewers)


def checksum(data: bytes) -> int:
    """Sum of bytes masked to 16 bits (the wire checksum)."""
    return sum(data) & 0xFFFF


def _build_control(cmd: int, payload: int) -> bytes:
    """Pack an 8-byte control frame for the given cmd/payload (len byte=0x02)."""
    body = struct.pack("<BBBBH", CONTROL_HEADER[0], CONTROL_HEADER[1], cmd, 0x02, payload)
    return body + struct.pack("<H", checksum(body))


def build_control_set_interval(interval_ms: int) -> bytes:
    """Pack the 8-byte 'set sampling interval' control frame."""
    # BB 66 | 01 | 02 | u16 interval_ms | u16 checksum (over the first 6 bytes)
    return _build_control(CMD_SET_INTERVAL, interval_ms)


def build_control_start_ota() -> bytes:
    """Pack the 8-byte 'start OTA update' control frame (payload unused -> 0).

    The firmware downloads the .bin itself over HTTP once it receives this.
    """
    return _build_control(CMD_START_OTA, 0)


def parse_sample(data: bytes) -> tuple[int, float, float, float] | None:
    """Decode one 20-byte sample frame.

    Returns (dev_ts, voltage, current, power_mw) or None if the frame header or
    checksum is invalid. `data` must be exactly SAMPLE_SIZE bytes.
    """
    if len(data) != SAMPLE_SIZE:
        return None
    if data[0:2] != SAMPLE_HEADER:
        return None
    if checksum(data[:SAMPLE_CKSUM_OFFSET]) != struct.unpack("<H", data[SAMPLE_CKSUM_OFFSET:])[0]:
        return None
    _hdr, dev_ts, voltage, current, _ck = struct.unpack(SAMPLE_FORMAT, data)
    power_mw = voltage * current            # (V) * (mA) = mW
    return dev_ts, voltage, current, power_mw


def parse_device_info(data: bytes) -> tuple[str, int] | None:
    """Decode one 37-byte device-info frame.

    Returns (version, slot) or None if the frame header or checksum is invalid.
    `data` must be exactly INFO_SIZE bytes. `version` is the running app's version
    string (NUL-terminated on the wire, stripped here); `slot` is the running
    OTA slot index (OTA_SLOT_0 / OTA_SLOT_1 / OTA_SLOT_UNKNOWN).
    """
    if len(data) != INFO_SIZE:
        return None
    if data[0:2] != INFO_HEADER:
        return None
    if checksum(data[:INFO_CKSUM_OFFSET]) != struct.unpack("<H", data[INFO_CKSUM_OFFSET:])[0]:
        return None
    _hdr, version, slot, _ck = struct.unpack(INFO_FORMAT, data)
    # The version field is a fixed 32-byte, NUL-padded string; decode as ascii and
    # drop the trailing NUL(s). The firmware writes only printable bytes.
    return version.decode("ascii", "replace").split("\x00", 1)[0], slot


def build_device_info(version: str, slot: int) -> bytes:
    """Pack a 37-byte device-info frame (the wire contract the firmware emits).

    `version` is padded/truncated to 32 bytes; `slot` is the running partition
    subtype. Useful for tests and any tooling that must speak the wire protocol.
    """
    version_bytes = version.encode("ascii", "replace")[:31].ljust(32, b"\x00")  # 32 B, NUL-padded
    body = struct.pack("<2s32sB", INFO_HEADER, version_bytes, slot)  # 35 bytes, no cksum
    return body + struct.pack("<H", checksum(body))


def parse_event(data: bytes) -> tuple[int, int, float, float, float] | None:
    """Decode one 25-byte OCP event frame.

    Returns (type, dev_ts, voltage, current, power_mw) or None if the frame
    header or checksum is invalid. `data` must be exactly EVENT_SIZE bytes.
    """
    if len(data) != EVENT_SIZE:
        return None
    if data[0:2] != EVENT_HEADER:
        return None
    if checksum(data[:EVENT_CKSUM_OFFSET]) != struct.unpack("<H", data[EVENT_CKSUM_OFFSET:])[0]:
        return None
    _hdr, etype, dev_ts, voltage, current, power, _ck = struct.unpack(EVENT_FORMAT, data)
    return etype, dev_ts, voltage, current, power


def build_event(etype: int, dev_ts: int, voltage: float, current: float, power: float) -> bytes:
    """Pack a 25-byte OCP event frame (the wire contract the firmware emits).

    Useful for tests and any tooling that must speak the wire protocol.
    """
    body = struct.pack("<2sBQfff", EVENT_HEADER, etype, dev_ts, voltage, current, power)
    return body + struct.pack("<H", checksum(body))
