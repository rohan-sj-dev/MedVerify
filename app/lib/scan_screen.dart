/// Scanner screen.
///
/// Formats are QR, DataMatrix *and* EAN-13 — not QR alone. An Indian pharmacy
/// shelf has all three on it, and a linear barcode must produce an honest
/// "cannot be checked" rather than a scanner that appears broken.
library;

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'api.dart';
import 'result_screen.dart';

class ScanScreen extends StatefulWidget {
  const ScanScreen({super.key, required this.api});

  final MedVerifyApi api;

  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends State<ScanScreen> {
  final MobileScannerController _controller = MobileScannerController(
    formats: const [BarcodeFormat.qrCode, BarcodeFormat.dataMatrix, BarcodeFormat.ean13],
    detectionSpeed: DetectionSpeed.noDuplicates,
  );

  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _onDetect(BarcodeCapture capture) async {
    if (_busy) return;
    final barcode = capture.barcodes.firstOrNull;
    final payload = barcode?.rawValue;
    if (payload == null || payload.isEmpty) return;

    setState(() {
      _busy = true;
      _error = null;
    });
    await _controller.stop();

    try {
      final verdict = await widget.api.scan(payload, _symbologyOf(barcode!.format));
      if (!mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => ResultScreen(verdict: verdict, parsed: null),
        ),
      );
    } on ApiException catch (err) {
      if (mounted) setState(() => _error = err.message);
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'Could not reach the server. Check it is running.');
      }
    } finally {
      if (mounted) setState(() => _busy = false);
      await _controller.start();
    }
  }

  static String _symbologyOf(BarcodeFormat format) => switch (format) {
        BarcodeFormat.qrCode => 'QR_CODE',
        BarcodeFormat.dataMatrix => 'DATA_MATRIX',
        BarcodeFormat.ean13 => 'EAN_13',
        BarcodeFormat.code128 => 'CODE_128',
        _ => 'UNKNOWN',
      };

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Scan a pack'),
        actions: [
          IconButton(
            onPressed: () => _controller.toggleTorch(),
            icon: const Icon(Icons.flashlight_on_outlined),
            tooltip: 'Torch',
          ),
        ],
      ),
      body: Stack(
        fit: StackFit.expand,
        children: [
          MobileScanner(controller: _controller, onDetect: _onDetect),
          const _ReticleOverlay(),
          if (_busy) const ColoredBox(color: Colors.black38, child: Center(child: CircularProgressIndicator())),
          Positioned(
            left: 16,
            right: 16,
            bottom: 28,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (_error != null) _ErrorBar(message: _error!),
                const SizedBox(height: 10),
                const _Hint(),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ReticleOverlay extends StatelessWidget {
  const _ReticleOverlay();

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: Center(
        child: Container(
          width: 240,
          height: 240,
          decoration: BoxDecoration(
            border: Border.all(color: Colors.white70, width: 2),
            borderRadius: BorderRadius.circular(12),
          ),
        ),
      ),
    );
  }
}

class _Hint extends StatelessWidget {
  const _Hint();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(8),
      ),
      child: const Text(
        'Point at the QR or barcode on the carton',
        textAlign: TextAlign.center,
        style: TextStyle(color: Colors.white, fontSize: 13.5),
      ),
    );
  }
}

class _ErrorBar extends StatelessWidget {
  const _ErrorBar({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFFA8372A),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.error_outline, color: Colors.white, size: 19),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              message,
              style: const TextStyle(color: Colors.white, fontSize: 13.5, height: 1.35),
            ),
          ),
        ],
      ),
    );
  }
}
