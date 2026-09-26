/// Dart mirror of the frozen verdict contract (src/contracts/verdict.js).
///
/// These classes read the wire shape and nothing more. The one rule that
/// matters: the UI branches on [ScanVerdict.verdict] and never on the text of
/// [ScanVerdict.narrative]. The narrative is written by an LLM from the
/// evidence; the verdict is computed deterministically on the server.
library;

enum VerdictLevel {
  genuine('GENUINE'),
  suspect('SUSPECT'),
  counterfeit('COUNTERFEIT'),
  notSerialized('NOT_SERIALIZED');

  const VerdictLevel(this.wire);
  final String wire;

  static VerdictLevel parse(String value) => VerdictLevel.values.firstWhere(
        (v) => v.wire == value,
        // An unrecognised verdict must never render as reassuring.
        orElse: () => VerdictLevel.suspect,
      );
}

class Evidence {
  const Evidence({required this.signal, this.value, this.unit, this.detail});

  final String signal;
  final Object? value;
  final String? unit;
  final String? detail;

  factory Evidence.fromJson(Map<String, dynamic> json) => Evidence(
        signal: json['signal'] as String,
        value: json['value'],
        unit: json['unit'] as String?,
        detail: json['detail'] as String?,
      );

  /// `geo_velocity` -> `Geo velocity`
  String get label {
    final words = signal.replaceAll('_', ' ');
    return words.isEmpty ? words : words[0].toUpperCase() + words.substring(1);
  }

  String? get reading {
    if (value == null) return null;
    return unit == null ? '$value' : '$value $unit';
  }
}

class AgentResult {
  const AgentResult({
    required this.agent,
    required this.verdict,
    this.score,
    this.hardFail = false,
    this.evidence = const [],
  });

  final String agent;
  final String verdict;
  final double? score;
  final bool hardFail;
  final List<Evidence> evidence;

  /// The agent had no basis to judge. Must never be shown as approval.
  bool get abstained => verdict == 'INSUFFICIENT_DATA';

  factory AgentResult.fromJson(Map<String, dynamic> json) => AgentResult(
        agent: json['agent'] as String,
        verdict: json['verdict'] as String,
        score: (json['score'] as num?)?.toDouble(),
        hardFail: json['hard_fail'] as bool? ?? false,
        evidence: ((json['evidence'] as List?) ?? const [])
            .map((e) => Evidence.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

class DrugRef {
  const DrugRef({this.brand, this.salt, this.strength, this.form, this.gtin});

  final String? brand;
  final String? salt;
  final String? strength;
  final String? form;
  final String? gtin;

  factory DrugRef.fromJson(Map<String, dynamic> json) => DrugRef(
        brand: json['brand'] as String?,
        salt: json['salt'] as String?,
        strength: json['strength'] as String?,
        form: json['form'] as String?,
        gtin: json['gtin'] as String?,
      );

  String get title => brand ?? salt ?? 'Unidentified medicine';

  String? get subtitle {
    final parts = [salt, strength, form].whereType<String>().toList();
    return parts.isEmpty ? null : parts.join(' · ');
  }
}

class BatchRef {
  const BatchRef({this.id, this.expiry, this.mfgDate, this.status});

  final String? id;
  final String? expiry;
  final String? mfgDate;
  final String? status;

  factory BatchRef.fromJson(Map<String, dynamic> json) => BatchRef(
        id: json['id'] as String?,
        expiry: json['expiry'] as String?,
        mfgDate: json['mfg_date'] as String?,
        status: json['status'] as String?,
      );
}

class Alternative {
  const Alternative({
    required this.brand,
    required this.salt,
    this.strength,
    this.verified = false,
  });

  final String brand;
  final String salt;
  final String? strength;
  final bool verified;

  factory Alternative.fromJson(Map<String, dynamic> json) => Alternative(
        brand: json['brand'] as String,
        salt: json['salt'] as String,
        strength: json['strength'] as String?,
        verified: json['verified'] as bool? ?? false,
      );
}

class ScanVerdict {
  const ScanVerdict({
    required this.scanId,
    required this.verdict,
    required this.confidence,
    required this.unitLevel,
    required this.drug,
    required this.batch,
    this.agents = const [],
    this.narrative,
    this.alternatives = const [],
    this.warnings = const [],
  });

  final String scanId;
  final VerdictLevel verdict;
  final double confidence;

  /// False for batch-level codes: the QR identifies the batch, not this pack,
  /// so clone detection cannot apply. The UI must say so plainly.
  final bool unitLevel;

  final DrugRef drug;
  final BatchRef batch;
  final List<AgentResult> agents;
  final String? narrative;
  final List<Alternative> alternatives;
  final List<String> warnings;

  factory ScanVerdict.fromJson(Map<String, dynamic> json) => ScanVerdict(
        scanId: json['scan_id'] as String,
        verdict: VerdictLevel.parse(json['verdict'] as String),
        confidence: (json['confidence'] as num).toDouble(),
        unitLevel: json['unit_level'] as bool,
        drug: DrugRef.fromJson((json['drug'] as Map?)?.cast<String, dynamic>() ?? {}),
        batch: BatchRef.fromJson((json['batch'] as Map?)?.cast<String, dynamic>() ?? {}),
        agents: ((json['agents'] as List?) ?? const [])
            .map((a) => AgentResult.fromJson(a as Map<String, dynamic>))
            .toList(),
        narrative: json['narrative'] as String?,
        alternatives: ((json['alternatives'] as List?) ?? const [])
            .map((a) => Alternative.fromJson(a as Map<String, dynamic>))
            .toList(),
        warnings: ((json['warnings'] as List?) ?? const []).cast<String>(),
      );

  /// Every piece of evidence behind this verdict, flattened for display.
  List<Evidence> get reasons => [for (final a in agents) ...a.evidence];

  bool get anyAgentAbstained => agents.any((a) => a.abstained);
}

/// Response of `POST /parse`. Used by the scan screen before a verdict exists.
class ParsedCode {
  const ParsedCode({
    required this.scheme,
    required this.symbology,
    required this.unitLevel,
    required this.serialPresent,
    this.gtin,
    this.batch,
    this.expiry,
    this.mfgDate,
    this.warnings = const [],
  });

  final String scheme;
  final String symbology;
  final bool unitLevel;
  final bool serialPresent;
  final String? gtin;
  final String? batch;
  final String? expiry;
  final String? mfgDate;
  final List<String> warnings;

  factory ParsedCode.fromJson(Map<String, dynamic> json) => ParsedCode(
        scheme: json['scheme'] as String,
        symbology: json['symbology'] as String,
        unitLevel: json['unit_level'] as bool,
        serialPresent: json['serial_present'] as bool,
        gtin: json['gtin'] as String?,
        batch: json['batch'] as String?,
        expiry: json['expiry'] as String?,
        mfgDate: json['mfg_date'] as String?,
        warnings: ((json['warnings'] as List?) ?? const []).cast<String>(),
      );
}
