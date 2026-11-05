/// Scanner screen.
///
/// Reads QR, DataMatrix and EAN-13 — an Indian pharmacy shelf has all three.
/// Only codes inside the square are read, and after a problem the scanner
/// waits for "Scan again" instead of retrying the same code in a loop.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'api.dart';
import 'device.dart';
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

  // Fetched as soon as the scanner opens, so they are ready by the time a
  // code is read and scanning never waits for the GPS.
  final Future<String> _phone = phoneId();
  late Future<Location?> _where = approximateLocation();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  // When a plain barcode was first seen with no QR code beside it (see _pick).
  DateTime? _barcodeSince;

  // Many packs carry a QR code or DataMatrix right next to a plain barcode, and
  // the QR code tells far more. So take a QR code or DataMatrix whenever one is
  // in view, and a plain barcode only after a moment with nothing better.
  Barcode? _pick(BarcodeCapture capture) {
    final codes = capture.barcodes.where((b) => (b.rawValue ?? '').isNotEmpty).toList();
    final twoD = codes.where((b) => b.format != BarcodeFormat.ean13).firstOrNull;
    if (twoD != null) return twoD;
    final plain = codes.firstOrNull;
    if (plain == null) return null;
    _barcodeSince ??= DateTime.now();
    if (DateTime.now().difference(_barcodeSince!) < const Duration(milliseconds: 800)) return null;
    return plain;
  }

  Future<void> _onDetect(BarcodeCapture capture) async {
    if (_paused) return; // ignore everything until the current code is dealt with

    final barcode = _pick(capture);
    if (barcode == null) return;
    _barcodeSince = null;

    setState(() {
      _paused = true;
      _checking = true;
      _error = null;
    });

    try {
      // A plain barcode, or a QR code that is only a web link, carries no
      // batch number. Ask for the one printed on the pack, so the server can
      // look for it on the maker's website and in CDSCO's alerts.
      final raw = barcode.rawValue!.trim();
      final bareLink = RegExp(r'^https?://', caseSensitive: false).hasMatch(raw) && !raw.contains('?');
      String? batch;
      if (barcode.format == BarcodeFormat.ean13 || bareLink) {
        setState(() => _checking = false);
        batch = await showDialog<String>(
          context: context,
          barrierDismissible: false,
          builder: (_) => _BatchDialog(
            why: bareLink
                ? "This QR code opens a website. If the pack shows a batch number (B.No.), type it to "
                    'check it against what the website says. You can skip this.'
                : 'This barcode names the medicine, not the batch. Type the batch number printed '
                    'near it (B.No.) to check it against CDSCO alerts.',
          ),
        );
        if (!mounted) return;
        setState(() => _checking = true);
      }

      final verdict = await widget.api.scan(
        barcode.rawValue!,
        _symbologyOf(barcode.format),
        location: await _where,
        phoneId: await _phone,
        printedBatch: batch,
      );
      if (!mounted) return;

      // Turn the camera off while the result is on screen, back on when we return.
      await _controller.stop();
      if (!mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute(builder: (_) => ResultScreen(verdict: verdict, parsed: null)),
      );
      await _controller.start();
      _where = approximateLocation(); // the next scan may be somewhere else
      if (mounted) setState(() => _paused = false);
    } on ApiException catch (err) {
      // For a code that can't be read, show what was in it, so it can be reported.
      final shown = barcode.rawValue!.length > 80 ? '${barcode.rawValue!.substring(0, 80)}…' : barcode.rawValue!;
      final message = err.statusCode == 422 ? '${err.message}\n\nIt reads: $shown' : err.message;
      if (mounted) setState(() => _error = message);
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

/// Asks for the batch number printed on the strip ("B.No. ROM401I").
/// Returns it, or null if the person skips.
class _BatchDialog extends StatefulWidget {
  const _BatchDialog({required this.why});

  final String why; // why the batch is needed, for this kind of code

  @override
  State<_BatchDialog> createState() => _BatchDialogState();
}

class _BatchDialogState extends State<_BatchDialog> {
  final _text = TextEditingController();

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  // Only what a batch number can contain, starting with a letter or digit.
  String? get _batch {
    final batch = _text.text.trim().replaceFirst(RegExp(r'^[^A-Za-z0-9]+'), '');
    return batch.isEmpty ? null : batch.toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Batch number'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(widget.why),
          const SizedBox(height: 12),
          TextField(
            controller: _text,
            autofocus: true,
            textCapitalization: TextCapitalization.characters,
            inputFormatters: [
              FilteringTextInputFormatter.allow(RegExp(r'[A-Za-z0-9./ -]')),
              LengthLimitingTextInputFormatter(30),
            ],
            decoration: const InputDecoration(hintText: 'e.g. ROM401I', border: OutlineInputBorder()),
            onSubmitted: (_) => Navigator.of(context).pop(_batch),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Skip')),
        FilledButton(onPressed: () => Navigator.of(context).pop(_batch), child: const Text('Check')),
      ],
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
