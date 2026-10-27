/// The verdict screen.
///
/// This is where Phase 1 earns its place in the plan: building it now is what
/// tells you whether the contract carries everything the user needs. Two rules
/// it holds to:
///
///  * Never render a bare "Genuine". Every verdict shows the claim *and* the
///    evidence behind it. Users calibrate trust on the reasoning, and the
///    reasoning is what protects you when the system is wrong.
///  * Branch on `verdict`, never on the narrative text. The narrative is
///    written by an LLM; the verdict is computed.
library;

import 'package:flutter/material.dart';

import 'models.dart';
import 'theme.dart';

class ResultScreen extends StatelessWidget {
  const ResultScreen({super.key, required this.verdict, required this.parsed});

  final ScanVerdict verdict;
  final ParsedCode? parsed;

  @override
  Widget build(BuildContext context) {
    final style = VerdictStyle.of(verdict);

    return Scaffold(
      appBar: AppBar(title: const Text('Result')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
        children: [
          _Banner(style: style, verdict: verdict),
          const SizedBox(height: 16),
          _DrugCard(verdict: verdict),
          if (verdict.narrative != null) ...[
            const SizedBox(height: 16),
            _NarrativeCard(text: verdict.narrative!),
          ],
          if (!verdict.unitLevel) ...[
            const SizedBox(height: 16),
            const _BatchLevelNotice(),
          ],
          if (verdict.reasons.isNotEmpty) ...[
            const SizedBox(height: 16),
            _EvidenceCard(verdict: verdict),
          ],
          if (verdict.alternatives.isNotEmpty) ...[
            const SizedBox(height: 16),
            _AlternativesCard(alternatives: verdict.alternatives),
          ],
          const SizedBox(height: 24),
          FilledButton.icon(
            onPressed: () => Navigator.of(context).pop(),
            icon: const Icon(Icons.qr_code_scanner),
            label: const Text('Scan another pack'),
          ),
          const SizedBox(height: 12),
          Text(
            'Scan ${verdict.scanId.substring(0, 8)}',
            textAlign: TextAlign.center,
            style: Theme.of(context)
                .textTheme
                .bodySmall
                ?.copyWith(color: const Color(0xFF78858F)),
          ),
        ],
      ),
    );
  }
}

class _Banner extends StatelessWidget {
  const _Banner({required this.style, required this.verdict});

  final VerdictStyle style;
  final ScanVerdict verdict;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: style.color,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(style.icon, color: style.onColor, size: 30),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  style.headline,
                  style: TextStyle(
                    color: style.onColor,
                    fontSize: 23,
                    fontWeight: FontWeight.w700,
                    height: 1.15,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            style.summary,
            style: TextStyle(color: style.onColor.withValues(alpha: 0.92), height: 1.4),
          ),
          if (verdict.anyAgentAbstained) ...[
            const SizedBox(height: 10),
            Text(
              'Some checks could not run, so this result is weaker than usual.',
              style: TextStyle(
                color: style.onColor.withValues(alpha: 0.85),
                fontSize: 12.5,
                fontStyle: FontStyle.italic,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _DrugCard extends StatelessWidget {
  const _DrugCard({required this.verdict});

  final ScanVerdict verdict;

  @override
  Widget build(BuildContext context) {
    final rows = <(String, String)>[
      if (verdict.batch.id != null) ('Batch', verdict.batch.id!),
      if (verdict.batch.expiry != null) ('Expires', verdict.batch.expiry!),
      if (verdict.batch.mfgDate != null) ('Manufactured', verdict.batch.mfgDate!),
      if (verdict.drug.gtin != null) ('GTIN', verdict.drug.gtin!),
    ];

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              verdict.drug.title,
              style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w600),
            ),
            if (verdict.drug.subtitle != null) ...[
              const SizedBox(height: 3),
              Text(
                verdict.drug.subtitle!,
                style: const TextStyle(color: Color(0xFF47555F)),
              ),
            ],
            if (rows.isNotEmpty) ...[
              const SizedBox(height: 14),
              const Divider(height: 1),
              const SizedBox(height: 12),
              for (final (label, value) in rows)
                Padding(
                  padding: const EdgeInsets.only(bottom: 7),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SizedBox(
                        width: 110,
                        child: Text(
                          label,
                          style: const TextStyle(
                            fontSize: 12.5,
                            color: Color(0xFF78858F),
                            letterSpacing: 0.4,
                          ),
                        ),
                      ),
                      Expanded(
                        child: Text(
                          value,
                          style: const TextStyle(
                            fontFamily: 'monospace',
                            fontSize: 13.5,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }
}

class _NarrativeCard extends StatelessWidget {
  const _NarrativeCard({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Text(text, style: const TextStyle(fontSize: 15.5, height: 1.5)),
      ),
    );
  }
}

/// The honest disclosure for a code that identifies a batch, not a pack.
class _BatchLevelNotice extends StatelessWidget {
  const _BatchLevelNotice();

  @override
  Widget build(BuildContext context) {
    return Card(
      color: const Color(0xFFF6EBD5),
      child: const Padding(
        padding: EdgeInsets.all(16),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.info_outline, size: 20, color: Color(0xFF8F6310)),
            SizedBox(width: 12),
            Expanded(
              child: Text(
                'This code is shared by every pack in the batch, so it cannot be checked for '
                'copying. A pack with its own serial number can be checked much more strongly.',
                style: TextStyle(color: Color(0xFF5A4409), height: 1.4, fontSize: 13.5),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _EvidenceCard extends StatelessWidget {
  const _EvidenceCard({required this.verdict});

  final ScanVerdict verdict;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            
            const SizedBox(height: 12),
            for (final agent in verdict.agents)
              if (agent.evidence.isNotEmpty) _AgentBlock(agent: agent),
          ],
        ),
      ),
    );
  }
}

class _AgentBlock extends StatelessWidget {
  const _AgentBlock({required this.agent});

  final AgentResult agent;

  // What each check is called on screen. The server's names are for programmers.
  static const _titles = {
    'ledger': 'Registry',
    'recall': 'Recall notices',
    'anomaly': 'Copy check',
    'vision': 'Pack photo',
  };

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(
                (_titles[agent.agent] ?? agent.agent).toUpperCase(),
                style: const TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                  letterSpacing: 0.9,
                  color: Color(0xFF1D3F73),
                ),
              ),
              if (agent.hardFail) ...[
                const SizedBox(width: 8),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                  decoration: BoxDecoration(
                    color: const Color(0xFFF7E4E0),
                    borderRadius: BorderRadius.circular(3),
                  ),
                  child: const Text(
                    'DECISIVE',
                    style: TextStyle(
                      fontSize: 9.5,
                      fontWeight: FontWeight.w700,
                      color: Color(0xFFA8372A),
                      letterSpacing: 0.6,
                    ),
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 6),
          for (final e in agent.evidence)
            Padding(
              padding: const EdgeInsets.only(left: 2, bottom: 5),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Padding(
                    padding: EdgeInsets.only(top: 6, right: 8),
                    child: SizedBox(
                      width: 4,
                      height: 4,
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          color: Color(0xFFB6C1CB),
                          shape: BoxShape.circle,
                        ),
                      ),
                    ),
                  ),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          e.reading == null ? e.label : '${e.label}: ${e.reading}',
                          style: const TextStyle(fontSize: 14),
                        ),
                        if (e.detail != null)
                          Text(
                            e.detail!,
                            style: const TextStyle(
                              fontSize: 12.5,
                              color: Color(0xFF78858F),
                              height: 1.35,
                            ),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _AlternativesCard extends StatelessWidget {
  const _AlternativesCard({required this.alternatives});

  final List<Alternative> alternatives;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'SAME COMPOSITION',
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w600,
                letterSpacing: 1.2,
                color: Color(0xFF78858F),
              ),
            ),
            const SizedBox(height: 10),
            for (final alt in alternatives)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(
                  children: [
                    Icon(
                      alt.verified ? Icons.check_circle_outline : Icons.circle_outlined,
                      size: 17,
                      color: alt.verified ? const Color(0xFF1F6B45) : const Color(0xFF78858F),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        alt.strength == null
                            ? '${alt.brand} · ${alt.salt}'
                            : '${alt.brand} · ${alt.salt} ${alt.strength}',
                        style: const TextStyle(fontSize: 14.5),
                      ),
                    ),
                  ],
                ),
              ),
            const SizedBox(height: 6),
            const Text(
              'Information only. Ask a pharmacist or doctor before switching medicine.',
              style: TextStyle(fontSize: 12, color: Color(0xFF78858F), height: 1.35),
            ),
          ],
        ),
      ),
    );
  }
}
