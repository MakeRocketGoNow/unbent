import Foundation

/// The tags with whatever is still in the field added on.
///
/// The keyboard's return key adds a typed tag, but nobody owes the field that key. On an
/// account with no tags yet there are no suggestions to tap, so typing is the only way
/// in, and the natural gesture is to type the word and tap Save. A sheet that drops it on
/// the way out has lost the one piece of filing the person did by hand — and says nothing,
/// since the note still saves. Every button that leaves a sheet runs its tags through
/// here, and so does the return key, so the two ways of entering a tag cannot disagree.
///
/// The Android app's half is `tagsWithDraft` in `TagEditor.kt`.
public func tagsWithDraft(_ tags: [String], _ draft: String) -> [String] {
    let tag = draft.trimmingCharacters(in: .whitespaces)
    if tag.isEmpty || tags.contains(where: { $0.caseInsensitiveCompare(tag) == .orderedSame }) { return tags }
    return tags + [tag]
}

/// The account's tags worth offering under the field: not the ones the note has, narrowed
/// by what has been typed, and a dozen at most.
///
/// Suggestions matter more than free typing here: an archive's tags are a vocabulary, and
/// "Dentist" typed as "dentist" is a second tag someone later has to fold back in.
public func tagSuggestions(_ all: [Tag], tags: [String], draft: String, limit: Int = 12) -> [String] {
    let typed = draft.trimmingCharacters(in: .whitespaces)
    return all.map(\.name)
        .filter { name in !tags.contains { $0.caseInsensitiveCompare(name) == .orderedSame } }
        .filter { typed.isEmpty || $0.range(of: typed, options: .caseInsensitive) != nil }
        .prefix(limit)
        .map { $0 }
}
