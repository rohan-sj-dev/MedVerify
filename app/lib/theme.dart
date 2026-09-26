/// Verdict presentation.
///
/// Colour is never the only signal — every verdict also carries an icon and a
/// word, so the result survives colour blindness, glare and a cheap screen in
/// a pharmacy. Used consistently by the result screen and its chips.
library;

import 'package:flutter/material.dart';

import 'models.dart';

class VerdictStyle {
  const VerdictStyle({
    required this.color,
    required this.onColor,
    required this.icon,
    required this.headline,
    required this.summary,
  });

  final Color color;
  final Color onColor;
  final IconData icon;

  /// Never a bare word: the headline states the claim, the summary its basis.
  final String headline;
  final String summary;

  static VerdictStyle of(ScanVerdict verdict) {
    switch (verdict.verdict) {
      case VerdictLevel.genuine:
        return VerdictStyle(
          color: const Color(0xFF1F6B45),
          onColor: Colors.white,
          icon: Icons.verified_outlined,
          headline: verdict.unitLevel ? 'Checks passed' : 'Batch checks passed',
          summary: verdict.unitLevel
              ? 'Registered with the manufacturer, and this pack behaves like a single pack.'
              : 'The batch is registered and in date, but this code cannot identify one pack.',
        );
      case VerdictLevel.suspect:
        return const VerdictStyle(
          color: Color(0xFF8F6310),
          onColor: Colors.white,
          icon: Icons.warning_amber_outlined,
          headline: 'Something is wrong',
          summary: 'Do not take this medicine until a pharmacist has checked it.',
        );
      case VerdictLevel.counterfeit:
        return const VerdictStyle(
          color: Color(0xFFA8372A),
          onColor: Colors.white,
          icon: Icons.dangerous_outlined,
          headline: 'Do not take this',
          summary: 'Return it to the pharmacy you bought it from and report it.',
        );
      case VerdictLevel.notSerialized:
        return const VerdictStyle(
          color: Color(0xFF47555F),
          onColor: Colors.white,
          icon: Icons.help_outline,
          headline: 'Cannot be checked',
          summary: 'This barcode identifies the product, not this pack.',
        );
    }
  }
}

ThemeData buildTheme() {
  const seed = Color(0xFF1D3F73);
  final scheme = ColorScheme.fromSeed(seedColor: seed);
  return ThemeData(
    colorScheme: scheme,
    useMaterial3: true,
    scaffoldBackgroundColor: const Color(0xFFF2F4F6),
    appBarTheme: const AppBarTheme(centerTitle: false),
    cardTheme: CardThemeData(
      elevation: 0,
      color: Colors.white,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(8),
        side: const BorderSide(color: Color(0xFFD3DAE1)),
      ),
    ),
  );
}
