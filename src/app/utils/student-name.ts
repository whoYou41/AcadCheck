export function parseStudentName(name: string): { firstName: string; middleName: string; lastName: string; error: string } {
  const parts = name.trim().split(/\s+/);
  const initialIndex = parts.findIndex(part => /^[A-Za-z]\.$/.test(part));
  const valid = initialIndex > 0 && initialIndex === parts.length - 2 &&
    parts.filter(part => /^[A-Za-z]\.$/.test(part)).length === 1;
  return {
    firstName: valid ? parts.slice(0, initialIndex).join(' ') : name.trim(),
    middleName: valid ? parts[initialIndex].toUpperCase() : '',
    lastName: valid ? parts[initialIndex + 1] : '',
    error: valid ? '' : 'Use First name M. Lastname, for example John Reelan E. Altobar'
  };
}
