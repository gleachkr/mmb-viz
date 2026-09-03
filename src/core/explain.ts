/**
 * Static explanations keyed by span kind. Dynamic, value-aware text is
 * produced by the UI formatter; this module holds the spec-derived prose.
 */
import type { SpanKind } from "./spans";

export interface Explanation {
  title: string;
  text: string;
  /** Heading in spec/mmb.md, for the spec companion. */
  spec?: string;
}

export const EXPLAIN: Record<SpanKind, Explanation> = {
  file: { title: "MMB file", text: "A Metamath Zero binary proof file. Every byte belongs to one of the structures below." },
  header: {
    title: "Header",
    text: "Forty bytes at the start of the file. It identifies the format, counts the declarations, and holds pointers (file offsets) to the term table, theorem table, proof stream, and optional debugging index.",
    spec: "Header",
  },
  "header.magic": { title: "magic", text: 'The four ASCII bytes "MM0B" (0x42304D4D as a little-endian u32). A verifier rejects a file whose first four bytes differ.', spec: "Header" },
  "header.version": { title: "version", text: "Format version. This tool and the spec describe version 1.", spec: "Header" },
  "header.num_sorts": { title: "num_sorts", text: "Number of sorts, and the length of the sort table that immediately follows the header. Sorts are addressed by 7-bit ids, so at most 128 fit.", spec: "Header" },
  "header.reserved": { title: "reserved", text: "Two reserved bytes. Must be zero.", spec: "Header" },
  "header.num_terms": { title: "num_terms", text: "Number of term and def declarations; the length of the term table.", spec: "Header" },
  "header.num_thms": { title: "num_thms", text: "Number of axiom and theorem declarations; the length of the theorem table.", spec: "Header" },
  "header.p_terms": { title: "p_terms", text: "File offset of the term table, an 8-byte-aligned array of num_terms entries.", spec: "Term Table" },
  "header.p_thms": { title: "p_thms", text: "File offset of the theorem table, an 8-byte-aligned array of num_thms entries.", spec: "Theorem Table" },
  "header.p_proof": { title: "p_proof", text: "File offset of the proof stream: the sequence of statements, each carrying its proof commands.", spec: "Proof Stream" },
  "header.reserved2": { title: "reserved2", text: "Four reserved bytes. Must be zero.", spec: "Header" },
  "header.p_index": { title: "p_index", text: "64-bit file offset of the debugging index, or zero if the file has none. The index supplies names for sorts, terms, theorems, variables, and hypotheses. Verification never depends on it.", spec: "Debugging Index" },
  sorts: { title: "Sort table", text: "One byte per sort, directly after the header. Each byte packs the sort modifiers.", spec: "Sort Table" },
  "sorts.entry": { title: "sort_data", text: "Bit 0 pure, bit 1 strict, bit 2 provable, bit 3 free. Bits 4 to 7 must be zero. A pure sort has no term constructors; a strict sort cannot be a dummy; only provable sorts can be hypotheses or conclusions; a free sort has no bound variables.", spec: "Sort Table" },
  terms: { title: "Term table", text: "An 8-byte-aligned array with one 8-byte entry per term or def. Each entry gives the arity, return sort, def flag, and a pointer to the binder data.", spec: "Term Table" },
  "terms.entry": { title: "term", text: "num_args (u16), ret_sort with the is_def high bit (u8), a reserved byte, and p_data (u32) pointing at the argument types.", spec: "Term Table" },
  "terms.num_args": { title: "num_args", text: "Number of arguments the term constructor takes. The Term proof command pops this many expressions.", spec: "Term Table" },
  "terms.ret_sort": { title: "ret_sort / is_def", text: "Low seven bits: the sort of the constructed expression. High bit: 1 if this is a def, which then has a unify stream describing its value.", spec: "Term Table" },
  "terms.reserved": { title: "reserved", text: "Must be zero.", spec: "Term Table" },
  "terms.p_data": { title: "p_data", text: "Offset of the term_data block: num_args argument types, the return type, and for defs the inline unify stream.", spec: "Term Table" },
  thms: { title: "Theorem table", text: "An 8-byte-aligned array with one 8-byte entry per axiom or theorem: arity and a pointer to the binder data and unify stream.", spec: "Theorem Table" },
  "thms.entry": { title: "thm", text: "num_args (u16), two reserved bytes, and p_data (u32).", spec: "Theorem Table" },
  "thms.num_args": { title: "num_args", text: "Number of expression arguments (variables) of the theorem. The Thm proof command pops this many expressions as the substitution.", spec: "Theorem Table" },
  "thms.reserved": { title: "reserved", text: "Must be zero.", spec: "Theorem Table" },
  "thms.p_data": { title: "p_data", text: "Offset of the thm_data block: num_args argument types followed by the inline unify stream for the hypotheses and conclusion.", spec: "Theorem Table" },
  termdata: { title: "term_data", text: "The binders of a term or def: one 8-byte arg per argument, then the return type as an arg, then (for defs only) the unify stream that encodes the definition's value.", spec: "Term Table" },
  "termdata.arg": { title: "arg", text: "A 64-bit binder descriptor. Bit 63: bound variable. Bits 56 to 62: sort. Bit 55: reserved, must be 0. Bits 0 to 54: which bound variables this argument may depend on, indexed among the bound variables only. A bound variable depends exactly on itself.", spec: "Term Table" },
  "termdata.ret": { title: "ret", text: "The return type as an arg. Its bound bit is 0 and its sort must equal ret_sort in the table entry. Its deps say which bound variables the result may mention.", spec: "Term Table" },
  thmdata: { title: "thm_data", text: "The binders of an axiom or theorem, one 8-byte arg per variable, followed inline by the unify stream giving its hypotheses and conclusion.", spec: "Theorem Table" },
  "thmdata.arg": { title: "arg", text: "A 64-bit binder descriptor, as in term_data: bound flag, sort, and dependency bitmap.", spec: "Theorem Table" },
  unify: {
    title: "Unify stream",
    text: "A byte-aligned list of (cmd, data) pairs ending in END that describes an expression in polish notation (constructor before subterms). For a def it is the value; for a theorem it is the conclusion followed by UHyp and each hypothesis. During verification the unifier walks this stream to match a target expression against it, building the substitution heap as it goes.",
    spec: "Unify Stream",
  },
  "unify.cmd": { title: "unify command", text: "UTerm t: expect a term application with head t and push its arguments. UTermSave t: the same, but first record the expression on the unify heap. URef i: the expression must be identical to unify heap entry i. UDummy s: bind a dummy of sort s (defs only). UHyp: pop the next hypothesis proof from the main stack and unify it (theorems only).", spec: "Unification" },
  proof: { title: "Proof stream", text: "The sequence of all statements, in declaration order. Each begins with a statement command whose data field is the byte length of the whole statement, so a verifier can skip forward without decoding proofs.", spec: "Proof Stream" },
  "proof.stmt": { title: "Statement", text: "One declaration: Sort, Term, Def, LocalDef, Axiom, Thm, or LocalThm. The running counts of sorts, terms, and theorems seen so far give the declaration its id in the tables.", spec: "Proof Stream" },
  "proof.stmt_cmd": { title: "statement command", text: "The opcode says which kind of declaration this is; the data field is the distance in bytes to the next statement. Term and Def share opcode 0x05; the is_def bit in the term table tells them apart.", spec: "Proof Stream" },
  "proof.body": { title: "proof body", text: "Proof commands in reverse polish notation (arguments before constructors), operating on a stack machine, terminated by END. For a def the body constructs the value; for an axiom or theorem it constructs each hypothesis (marked with Hyp) and then the conclusion, which for a theorem must be proven.", spec: "Proof Checking" },
  "proof.cmd": { title: "proof command", text: "One stack-machine instruction. See the Proof Checking section for the rule each opcode applies.", spec: "Proof Checking" },
  "proof.end": { title: "END", text: "The zero byte that ends the proof stream. It must begin at least 5 bytes before the end of the file so that a verifier may read ahead a full 5-byte command.", spec: "Proof Stream" },
  index: { title: "Debugging index", text: "A u64 entry count followed by 16-byte entries, each a 4-byte table type, a u32 data field, and a u64 pointer. Known types are Name, VarN, and HypN.", spec: "Debugging Index" },
  "index.num_entries": { title: "num_entries", text: "Number of index entries that follow.", spec: "Debugging Index" },
  "index.entry": { title: "index_entry", text: "type (str4), data (u32), ptr (u64). Unknown types are skipped.", spec: "Debugging Index" },
  "index.entry_type": { title: "type", text: "Four ASCII bytes naming the table.", spec: "Debugging Index" },
  "index.entry_data": { title: "data", text: "Table-specific; zero for the three standard tables.", spec: "Debugging Index" },
  "index.entry_ptr": { title: "ptr", text: "File offset of the table.", spec: "Debugging Index" },
  names: { title: "Name table", text: "For every sort, then term, then theorem: a pointer to its statement in the proof stream and a pointer to its NUL-terminated UTF-8 name.", spec: "The `Name` table: names for statements" },
  "names.entry": { title: "name_entry", text: "proof (p64, nullable) and name (p64, nullable).", spec: "The `Name` table: names for statements" },
  "names.p_proof": { title: "proof", text: "Offset of the statement that introduced this declaration, or zero.", spec: "The `Name` table: names for statements" },
  "names.p_name": { title: "name", text: "Offset of the name string, or zero.", spec: "The `Name` table: names for statements" },
  varnames: { title: "VarN table", text: "For every term, then theorem: a nullable pointer to a string list naming its variables in declaration order, continuing past the declared arguments with the dummies in order of Dummy commands.", spec: "The `VarN` table: names for variables" },
  "varnames.ptr": { title: "variable names pointer", text: "Offset of a str_list, or zero.", spec: "The `VarN` table: names for variables" },
  hypnames: { title: "HypN table", text: "For every theorem: a nullable pointer to a string list naming its hypotheses in the order of Hyp commands.", spec: "The `HypN` table: names for hypotheses" },
  "hypnames.ptr": { title: "hypothesis names pointer", text: "Offset of a str_list, or zero.", spec: "The `HypN` table: names for hypotheses" },
  strlist: { title: "str_list", text: "A u64 count followed by that many nullable u64 string pointers.", spec: "The `VarN` table: names for variables" },
  "strlist.count": { title: "num_strs", text: "Number of string pointers in the list.", spec: "The `VarN` table: names for variables" },
  "strlist.ptr": { title: "string pointer", text: "Offset of a NUL-terminated UTF-8 string, or zero.", spec: "The `VarN` table: names for variables" },
  string: { title: "cstr", text: "A NUL-terminated UTF-8 string. MM0 names are ASCII, but the index permits any Unicode.", spec: "Debugging Index" },
  padding: { title: "Padding", text: "Zero bytes inserted so that the following structure is 8-byte aligned, or the 4 bytes of read-ahead slack after the final END." },
  unaccounted: { title: "Unaccounted bytes", text: "Bytes that no structure references. A well-formed file produced by mm0-rs has none; their presence suggests a bad pointer or truncation elsewhere." },
};
