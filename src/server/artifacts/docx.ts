import type { ArtifactSpec, ArtifactTable } from "@/types/chat-v3";
import { loadBundledChineseFont } from "./pdf";

const encoder = new TextEncoder();
const EMBEDDED_FONT_KEY = "{00112233-4455-6677-8899-AABBCCDDEEFF}";
const EMBEDDED_FONT_NAME = "OpenVac Noto Sans Hans";

export async function renderDocx(
  spec: ArtifactSpec,
  options: { fontBytes?: Uint8Array } = {}
): Promise<Uint8Array> {
  const files: ZipEntry[] = [
    textEntry("[Content_Types].xml", contentTypesXml),
    textEntry("_rels/.rels", packageRelationshipsXml),
    textEntry("docProps/app.xml", appPropertiesXml),
    textEntry("docProps/core.xml", corePropertiesXml(spec)),
    textEntry("word/_rels/document.xml.rels", documentRelationshipsXml),
    textEntry("word/_rels/fontTable.xml.rels", fontTableRelationshipsXml),
    textEntry("word/document.xml", documentXml(spec)),
    textEntry("word/fontTable.xml", fontTableXml),
    {
      name: "word/fonts/OpenVacNotoSansHans.odttf",
      bytes: obfuscateOfficeFont(
        options.fontBytes ?? (await loadBundledChineseFont()),
        EMBEDDED_FONT_KEY
      )
    },
    textEntry("word/styles.xml", stylesXml)
  ];

  return createStoredZip(files);
}

function documentXml(spec: ArtifactSpec): string {
  const content = [
    paragraph(spec.title, "Title"),
    paragraph(spec.summary, "Summary"),
    ...spec.sections.flatMap((section) => [
      paragraph(section.heading, "Heading1"),
      ...section.paragraphs.map((value) => paragraph(value, "Normal"))
    ]),
    ...spec.tables.flatMap((table, index) => [
      paragraph(table.title ?? `表 ${index + 1}`, "Heading2"),
      tableXml(table)
    ])
  ].join("");

  return xml(`
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${content}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body>
</w:document>`);
}

function paragraph(text: string, style: string): string {
  const runs = text.split("\n").map((line, index) => {
    const prefix = index > 0 ? "<w:br/>" : "";
    return `<w:r>${prefix}<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`;
  });
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${runs.join("")}</w:p>`;
}

function tableXml(table: ArtifactTable): string {
  const row = (cells: string[], header: boolean) =>
    `<w:tr>${cells
      .map(
        (cell) =>
          `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${header ? '<w:shd w:fill="E8EEF4"/>' : ""}</w:tcPr>${paragraph(cell, header ? "TableHeader" : "TableText")}</w:tc>`
      )
      .join("")}</w:tr>`;
  return `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>${row(table.columns, true)}${table.rows.map((cells) => row(cells, false)).join("")}</w:tbl>`;
}

function corePropertiesXml(spec: ArtifactSpec): string {
  return xml(`
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(spec.title)}</dc:title><dc:creator>OpenVac</dc:creator><cp:lastModifiedBy>OpenVac</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">2000-01-01T00:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2000-01-01T00:00:00Z</dcterms:modified>
</cp:coreProperties>`);
}

function xml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body.trim()}`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const contentTypesXml = xml(`
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`);

const packageRelationshipsXml = xml(`
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);

const documentRelationshipsXml = xml(`
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/></Relationships>`);

const fontTableRelationshipsXml = xml(`
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/OpenVacNotoSansHans.odttf"/></Relationships>`);

const fontTableXml = xml(`
<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:font w:name="${EMBEDDED_FONT_NAME}"><w:altName w:val="Noto Sans CJK SC"/><w:charset w:val="86"/><w:family w:val="swiss"/><w:embedRegular r:id="rId1" w:fontKey="${EMBEDDED_FONT_KEY}" w:subsetted="false"/></w:font></w:fonts>`);

const appPropertiesXml = xml(`
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>OpenVac</Application><AppVersion>1.0</AppVersion></Properties>`);

const stylesXml = xml(`
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${EMBEDDED_FONT_NAME}" w:eastAsia="${EMBEDDED_FONT_NAME}" w:hAnsi="${EMBEDDED_FONT_NAME}"/><w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Summary"><w:name w:val="Summary"/><w:basedOn w:val="Normal"/><w:rPr><w:color w:val="44546A"/><w:sz w:val="22"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="TableHeader"><w:name w:val="Table Header"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="18"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="18"/></w:rPr></w:style>
</w:styles>`);

type ZipEntry = { name: string; bytes: Uint8Array };

function textEntry(name: string, content: string): ZipEntry {
  return { name, bytes: encoder.encode(content) };
}

function obfuscateOfficeFont(
  fontBytes: Uint8Array,
  fontKey: string
): Uint8Array {
  const key = fontKey
    .replace(/[{}-]/gu, "")
    .match(/.{2}/gu)
    ?.map((pair) => Number.parseInt(pair, 16))
    .reverse();
  if (!key || key.length !== 16) {
    throw new Error("Invalid deterministic DOCX font key.");
  }
  const output = fontBytes.slice();
  for (let index = 0; index < Math.min(32, output.length); index += 1) {
    output[index] ^= key[index % key.length]!;
  }
  return output;
}

function createStoredZip(inputEntries: ZipEntry[]): Uint8Array {
  const entries = [...inputEntries].sort((left, right) =>
    left.name.localeCompare(right.name, "en")
  );
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const checksum = crc32(entry.bytes);
    const local = new Uint8Array(30 + name.length + entry.bytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0x0021, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, entry.bytes.length, true);
    localView.setUint32(22, entry.bytes.length, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(entry.bytes, 30 + name.length);
    localParts.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0x0021, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, entry.bytes.length, true);
    centralView.setUint32(24, entry.bytes.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce(
    (total, part) => total + part.length,
    0
  );
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  endView.setUint16(20, 0, true);
  return concatenate([...localParts, ...centralParts, end]);
}

function concatenate(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0)
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
