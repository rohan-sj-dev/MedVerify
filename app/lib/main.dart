/// Scans a pack, sends the payload to the gateway for parsing, and renders a
/// verdict. The verdicts are canned in this phase; real agents arrive in
/// Phase 2 and nothing in this app changes when they do, because both speak
/// the same frozen contract.
library;

import 'package:flutter/material.dart';

import 'api.dart';
import 'result_screen.dart';
import 'scan_screen.dart';
import 'theme.dart';

void main() => runApp(const MedVerifyApp());

class MedVerifyApp extends StatelessWidget {
  const MedVerifyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'MedVerify',
      theme: buildTheme(),
      debugShowCheckedModeBanner: false,
      home: const HomeScreen(),
    );
  }
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final MedVerifyApi _api = MedVerifyApi();

  @override
  void dispose() {
    _api.close();
    super.dispose();
  }

  Future<void> _openFixture(String testCase) async {
    try {
      final verdict = await _api.mockScan(testCase);
      if (!mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute(builder: (_) => ResultScreen(verdict: verdict, parsed: null)),
      );
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Could not reach ${_api.baseUrl}. Is the gateway running?')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(24, 40, 24, 24),
          children: [
            const Text(
              'MedVerify',
              style: TextStyle(fontSize: 34, fontWeight: FontWeight.w700, letterSpacing: -0.5),
            ),
            const SizedBox(height: 8),
            const Text(
              'Check whether a pack of medicine is genuine before you take it.',
              style: TextStyle(fontSize: 16, color: Color(0xFF47555F), height: 1.4),
            ),
            const SizedBox(height: 32),
            FilledButton.icon(
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => ScanScreen(api: _api)),
              ),
              icon: const Icon(Icons.qr_code_scanner),
              label: const Text('Scan a pack'),
              style: FilledButton.styleFrom(
                minimumSize: const Size.fromHeight(52),
                textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
              ),
            ),
            const SizedBox(height: 40),
            const Divider(),
            const SizedBox(height: 16),
            
            const SizedBox(height: 6),
            const Text(
              'Verdicts are canned in this phase, so every screen can be reviewed without '
              'a registry behind it.',
              style: TextStyle(fontSize: 13, color: Color(0xFF78858F), height: 1.4),
            ),
            const SizedBox(height: 14),
            for (final (label, testCase) in const [
              ('Genuine, serialised pack', 'genuine'),
              ('Genuine, batch-level code', 'batch_level'),
              ('Suspect — cloned code', 'suspect'),
              ('Counterfeit — serial never issued', 'counterfeit'),
              ('Retail barcode, not serialised', 'not_serialized'),
            ])
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: OutlinedButton(
                  onPressed: () => _openFixture(testCase),
                  style: OutlinedButton.styleFrom(
                    minimumSize: const Size.fromHeight(46),
                    alignment: Alignment.centerLeft,
                  ),
                  child: Text(label),
                ),
              ),
            const SizedBox(height: 20),
            Text(
              'Gateway: ${_api.baseUrl}',
              style: const TextStyle(fontSize: 11.5, color: Color(0xFF9AA5AE)),
            ),
          ],
        ),
      ),
    );
  }
}
