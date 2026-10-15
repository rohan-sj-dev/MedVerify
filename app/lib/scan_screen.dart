/// Scanner screen.
///
/// Reads QR, DataMatrix and EAN-13 — an Indian pharmacy shelf has all three.
/// Only codes inside the square are read, and after a problem the scanner
/// waits for "Scan again" instead of retrying the same code in a loop.
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
  );

  bool _paused = false; // true while a code is being checked, or an error is showing
  bool _checking = false; // true while waiting for the server
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _onDetect(BarcodeCapture capture) async {
    if (_paused) return; // ignore everything until the current code is dealt with

    final barcode = capture.barcodes.where((b) => (b.rawValue ?? '').isNotEmpty).firstOrNull;
    if (barcode == null) return;

    setState(() {
      _paused = true;
      _checking = true;
      _error = null;
    });

    try {
      final verdict = await widget.api.scan(barcode.rawValue!, _symbologyOf(barcode.format));
      if (!mounted) return;

      // Turn the camera off while the result is on screen, back on when we return.
      await _controller.stop();
      if (!mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute(builder: (_) => ResultScreen(verdict: verdict, parsed: null)),
      );
      await _controller.start();
      if (mounted) setState(() => _paused = false);
    } on ApiException catch (err) {
      if (mounted) setState(() => _error = err.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not reach the server at ${widget.api.baseUrl}.');
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  void _scanAgain() => setState(() {
        _error = null;
        _paused = false;
      });

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
      body: LayoutBuilder(
        builder: (context, constraints) {
          // One square, centred in the camera view. The same rectangle is used
          // to draw the frame and to decide which codes are read, so they can
          // never disagree.
          final size = constraints.biggest;
          final side = size.shortestSide * 0.7;
          final scanWindow = Rect.fromCenter(center: size.center(Offset.zero), width: side, height: side);

          return Stack(
            fit: StackFit.expand,
            children: [
              MobileScanner(controller: _controller, scanWindow: scanWindow, onDetect: _onDetect),
              ScanWindowOverlay(
                controller: _controller,
                scanWindow: scanWindow,
                borderColor: Colors.white,
                borderWidth: 3,
                borderRadius: BorderRadius.circular(12),
              ),
              Positioned(
                left: 16,
                right: 16,
                bottom: 28,
                child: _error != null
                    ? _ErrorCard(message: _error!, onScanAgain: _scanAgain)
                    : _Hint(checking: _checking),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _Hint extends StatelessWidget {
  const _Hint({required this.checking});

  final bool checking;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          if (checking) ...[
            const SizedBox(
              width: 14,
              height: 14,
              child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
            ),
            const SizedBox(width: 10),
          ],
          Text(
            checking ? 'Checking…' : 'Fit the code on the box inside the square',
            style: const TextStyle(color: Colors.white, fontSize: 13.5),
          ),
        ],
      ),
    );
  }
}

class _ErrorCard extends StatelessWidget {
  const _ErrorCard({required this.message, required this.onScanAgain});

  final String message;
  final VoidCallback onScanAgain;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 8),
      decoration: BoxDecoration(
        color: const Color(0xFFA8372A),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
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
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(
              onPressed: onScanAgain,
              style: TextButton.styleFrom(foregroundColor: Colors.white),
              child: const Text('Scan again'),
            ),
          ),
        ],
      ),
    );
  }
}
