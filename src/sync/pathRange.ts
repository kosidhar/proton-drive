// A path or anything under it, as a byte-exact range rather than LIKE, which ignores case and treats '_' as a
// wildcard, so 'Photos/%' would also match 'photos/...'; '0' is the character after '/'. It can also use an index
// on the column. Bind it with selfOrDescendant().
export function selfOrDescendantWhere(column: string): string {
    return `${column} = $path OR (${column} >= $lo AND ${column} < $hi)`;
}

export function selfOrDescendant(relPath: string) {
    return { $path: relPath, $lo: `${relPath}/`, $hi: `${relPath}0` };
}
