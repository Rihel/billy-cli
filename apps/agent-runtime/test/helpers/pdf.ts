/**
 * 生成一份**结构合法的最小 PDF**（含真实 xref 偏移），供解码器测试使用。
 *
 * 为什么不塞一个二进制夹具进仓库：
 * - 二进制 diff 看不清、review 不了，改一次就整段变色；
 * - 用几行代码造出来的 PDF 既**可读**（内容就是参数），又**可改**（换文字只改调用处）。
 *
 * 结构是最小可解析的：Catalog → Pages → Page → Contents(文本流) + Font，
 * 末尾按规范写 xref 表与 startxref —— pdfjs 这类严格的解析器要求偏移正确，否则直接拒绝。
 */
export const minimalPdf = (text = 'Hello Billy PDF'): Buffer => {
  const stream = `BT /F1 12 Tf 20 150 Td (${text}) Tj ET`
  const body = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    body,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })

  const xrefStart = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`

  return Buffer.from(pdf, 'latin1')
}
