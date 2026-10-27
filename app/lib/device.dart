/// What the server needs about each scan to spot copied codes: roughly where
/// it happened, and which phone made it.
///
/// Location is approximate on purpose — the phone's coarse location, rounded
/// to about 100 m. That is enough to notice one code being scanned in two
/// cities at once, without tracking anyone. If the user says no, scanning
/// still works; copy detection just has less to go on.
library;

import 'dart:math';

import 'package:geolocator/geolocator.dart';
import 'package:shared_preferences/shared_preferences.dart';

typedef Location = ({double lat, double lon});

/// A random ID for this install, made once and then remembered. It says
/// nothing about the phone or its owner — it only lets the server tell
/// "the same phone again" from "a different phone".
Future<String> phoneId() async {
  final prefs = await SharedPreferences.getInstance();
  final saved = prefs.getString('phone_id');
  if (saved != null) return saved;

  final random = Random.secure();
  final id = List.generate(16, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
  await prefs.setString('phone_id', id);
  return id;
}

/// Roughly where the phone is now, or null if location is off or not allowed.
Future<Location?> approximateLocation() async {
  try {
    if (!await Geolocator.isLocationServiceEnabled()) return null;

    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) permission = await Geolocator.requestPermission();
    if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) return null;

    // The phone may remember a position from hours ago, in another city. Using
    // that would make a real pack look like it moved impossibly fast, so only
    // a position from the last ten minutes is good enough.
    Position? position;
    try {
      final last = await Geolocator.getLastKnownPosition();
      if (last != null && DateTime.now().difference(last.timestamp) < const Duration(minutes: 10)) {
        position = last;
      }
    } catch (_) {
      // Not available on every platform (the web, for one). Ask for a fresh one instead.
    }
    position ??= await Geolocator.getCurrentPosition(
      locationSettings: const LocationSettings(accuracy: LocationAccuracy.low, timeLimit: Duration(seconds: 5)),
    );

    double roughly(double degrees) => (degrees * 1000).round() / 1000; // ~100 m
    return (lat: roughly(position.latitude), lon: roughly(position.longitude));
  } catch (_) {
    return null; // no location is fine: the scan still goes ahead
  }
}
