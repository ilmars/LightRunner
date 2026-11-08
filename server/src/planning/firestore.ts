// Firestore's REST documents, as the planning service stores its services and songs.

/** Turn a Firestore REST document ({ fields: { x: { stringValue } } }) into plain JSON. */
export function fromFirestore(doc: any): any {
  const value = (v: any): any => {
    if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, value(x)]));
    if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(value);
    if ('integerValue' in v) return Number(v.integerValue);
    if ('nullValue' in v) return null;
    return Object.values(v)[0]; // string, double, boolean, timestamp, reference
  };
  return value({ mapValue: { fields: doc.fields } });
}
