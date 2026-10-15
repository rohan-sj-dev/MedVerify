/// Gateway client.
///
/// Base URL defaults to the Android emulator's host alias. Override at run
/// time for a physical device on the same network:
///
///   flutter run --dart-define=MEDVERIFY_API=http://192.168.1.20:3000
library;

import 'dart:convert';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:http/http.dart' as http;

import 'models.dart';

class ApiException implements Exception {
  ApiException(this.message, {this.statusCode});

  final String message;
  final int? statusCode;

  @override
  String toString() => message;
}

class MedVerifyApi {
  MedVerifyApi({String? baseUrl, http.Client? client})
      : baseUrl = baseUrl ?? _defaultBaseUrl(),
        _client = client ?? http.Client();

  /// Where the gateway lives, unless overridden.
  ///
  /// The right answer differs per target and getting it wrong looks like the
  /// server being down:
  ///
  ///   web       localhost — the browser is on the same machine
  ///   emulator  10.0.2.2  — the emulator's alias for the host machine
  ///   phone     neither; pass your machine's LAN address explicitly:
  ///             flutter run --dart-define=MEDVERIFY_API=http://192.168.x.x:3000
  static String _defaultBaseUrl() {
    const override = String.fromEnvironment('MEDVERIFY_API');
    if (override.isNotEmpty) return override;
    return kIsWeb ? 'http://localhost:3000' : 'http://10.0.2.2:3000';
  }

  final String baseUrl;
  final http.Client _client;

  static const _timeout = Duration(seconds: 10);

  /// Parse a scanned payload. Does not verify it — that arrives in Phase 2.
  Future<ParsedCode> parse(String payload, String symbology) async {
    final res = await _client
        .post(
          Uri.parse('$baseUrl/parse'),
          headers: const {'content-type': 'application/json'},
          body: jsonEncode({'payload': payload, 'symbology': symbology}),
        )
        .timeout(_timeout);

    if (res.statusCode == 422) {
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      throw ApiException(
        body['detail'] as String? ?? 'This code could not be read.',
        statusCode: 422,
      );
    }
    if (res.statusCode != 200) {
      throw ApiException('Gateway at $baseUrl returned ${res.statusCode}',
          statusCode: res.statusCode);
    }
    return ParsedCode.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
  }

  /// Verify a scanned pack against the registry (POST /scan).
  Future<ScanVerdict> scan(String payload, String symbology) async {
    final res = await _client
        .post(
          Uri.parse('$baseUrl/scan'),
          headers: const {'content-type': 'application/json'},
          body: jsonEncode({'payload': payload, 'symbology': symbology}),
        )
        .timeout(_timeout);

    // 422: the code could not be read. 503: the registry could not be reached.
    if (res.statusCode == 422 || res.statusCode == 503) {
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      throw ApiException(
        body['detail'] as String? ?? 'This code could not be checked.',
        statusCode: res.statusCode,
      );
    }
    if (res.statusCode != 200) {
      throw ApiException('Gateway at $baseUrl returned ${res.statusCode}', statusCode: res.statusCode);
    }
    return ScanVerdict.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
  }

  /// Example verdicts, for the example screens on the home page only.
  Future<ScanVerdict> mockScan(String testCase) async {
    final res = await _client
        .get(Uri.parse('$baseUrl/mock/scan?case=$testCase'))
        .timeout(_timeout);
    if (res.statusCode != 200) {
      throw ApiException('Gateway returned ${res.statusCode}', statusCode: res.statusCode);
    }
    return ScanVerdict.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
  }

  void close() => _client.close();
}
