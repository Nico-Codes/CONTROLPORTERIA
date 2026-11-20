#!/usr/bin/env python3
"""Regenera los PDF de documentación desde los Markdown del repositorio.

Requiere Python 3 y ReportLab:

    pip install reportlab
    python tools/generar_pdf.py

Los PDF se escriben en output/pdf/ y no deben editarse a mano.
"""

from pathlib import Path
import re

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    HRFlowable,
    LongTable,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Preformatted,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.platypus.tableofcontents import TableOfContents


RAIZ = Path(__file__).resolve().parent.parent
ANCHO_PAGINA, ALTO_PAGINA = letter
MARGEN = 53.9
ANCHO_UTIL = ANCHO_PAGINA - 2 * MARGEN

COLOR_TINTA = colors.HexColor("#0F172A")
COLOR_TEXTO = colors.HexColor("#1F2937")
COLOR_SUAVE = colors.HexColor("#64748B")
COLOR_BORDE = colors.HexColor("#E2E8F0")
COLOR_FONDO = colors.HexColor("#F8FAFC")
COLOR_ENCABEZADO = colors.HexColor("#F1F5F9")

DOCUMENTOS = [
    {
        "markdown": RAIZ / "documentacion_control_rondas_meatex.md",
        "pdf": RAIZ / "output" / "pdf" / "Manual_Tecnico_Control_Rondas_Meatex.pdf",
        "descripcion": "Aplicación web progresiva para registro y auditoría de rondas de vigilancia.",
        "detalle": "Incluye arquitectura, operación, reglas de rondas, datos, seguridad, notificaciones y pruebas.",
    },
    {
        "markdown": RAIZ / "GUIA_OPERATIVA.md",
        "pdf": RAIZ / "output" / "pdf" / "Guia_Operativa_Control_Rondas_Meatex.pdf",
        "descripcion": "Aplicación web progresiva para registro y auditoría de rondas de vigilancia.",
        "detalle": "Guía para desarrollo, publicación, configuración de servicios y solución de problemas.",
    },
]


def registrar_fuentes():
    """Usa Arial si está disponible; si no, cae a Helvetica."""
    candidatos = [
        (Path(r"C:\Windows\Fonts\arial.ttf"), Path(r"C:\Windows\Fonts\arialbd.ttf")),
        (Path("/usr/share/fonts/truetype/msttcorefonts/Arial.ttf"),
         Path("/usr/share/fonts/truetype/msttcorefonts/Arial_Bold.ttf")),
        (Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
         Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf")),
    ]
    for normal, negrita in candidatos:
        if normal.exists() and negrita.exists():
            pdfmetrics.registerFont(TTFont("Cuerpo", str(normal)))
            pdfmetrics.registerFont(TTFont("CuerpoBold", str(negrita)))
            pdfmetrics.registerFontFamily(
                "Cuerpo", normal="Cuerpo", bold="CuerpoBold",
                italic="Cuerpo", boldItalic="CuerpoBold",
            )
            return
    pdfmetrics.registerFontFamily(
        "Cuerpo", normal="Helvetica", bold="Helvetica-Bold",
        italic="Helvetica-Oblique", boldItalic="Helvetica-BoldOblique",
    )


def estilos():
    base = dict(fontName="Cuerpo", textColor=COLOR_TEXTO, alignment=TA_LEFT)
    base_cita = dict(base, textColor=COLOR_SUAVE)
    return {
        "body": ParagraphStyle("Body", fontSize=9, leading=13.5, spaceAfter=6, **base),
        "h1": ParagraphStyle("H1", fontName="CuerpoBold", fontSize=18, leading=22,
                             textColor=COLOR_TINTA, spaceBefore=18, spaceAfter=8,
                             keepWithNext=1),
        "h2": ParagraphStyle("H2", fontName="CuerpoBold", fontSize=12.5, leading=16,
                             textColor=COLOR_TINTA, spaceBefore=14, spaceAfter=5,
                             keepWithNext=1),
        "h3": ParagraphStyle("H3", fontName="CuerpoBold", fontSize=10.5, leading=14,
                             textColor=COLOR_TINTA, spaceBefore=10, spaceAfter=3,
                             keepWithNext=1),
        "bullet": ParagraphStyle("Bullet", fontSize=9, leading=13.5, spaceAfter=3,
                                 leftIndent=13, bulletIndent=5,
                                 bulletFontName="CuerpoBold", bulletFontSize=9,
                                 **base),
        "quote": ParagraphStyle("Quote", fontSize=9, leading=13.5, spaceAfter=6,
                                leftIndent=14, **base_cita),
        "code": ParagraphStyle("Code", fontName="Courier", fontSize=7.5, leading=10,
                               textColor=COLOR_TINTA),
        "table_head": ParagraphStyle("TableHead", fontName="CuerpoBold", fontSize=8,
                                     leading=10, textColor=COLOR_TINTA),
        "table_cell": ParagraphStyle("TableCell", fontName="Cuerpo", fontSize=7.4,
                                     leading=10, textColor=COLOR_TEXTO),
        "eyebrow": ParagraphStyle("Eyebrow", fontName="CuerpoBold", fontSize=9,
                                  leading=11, textColor=COLOR_SUAVE),
        "title": ParagraphStyle("Title", fontName="CuerpoBold", fontSize=28,
                                leading=34, textColor=COLOR_TINTA),
        "subtitle": ParagraphStyle("Subtitle", fontName="Cuerpo", fontSize=13,
                                   leading=17, textColor=COLOR_TEXTO),
        "revision": ParagraphStyle("Revision", fontName="Cuerpo", fontSize=9,
                                   leading=13, textColor=COLOR_TEXTO),
        "lead": ParagraphStyle("Lead", fontName="Cuerpo", fontSize=13,
                               leading=17, textColor=COLOR_TEXTO),
        "small": ParagraphStyle("Small", fontName="Cuerpo", fontSize=9,
                                leading=13, textColor=COLOR_TEXTO),
        "toc_title": ParagraphStyle("TocTitle", fontName="CuerpoBold", fontSize=19,
                                    leading=24, textColor=COLOR_TINTA, spaceAfter=14),
        "toc1": ParagraphStyle("TOC1", fontName="CuerpoBold", fontSize=10,
                               leading=16, textColor=COLOR_TINTA, spaceBefore=6),
        "toc2": ParagraphStyle("TOC2", fontName="Cuerpo", fontSize=8.5, leading=14,
                               leftIndent=14, textColor=COLOR_TEXTO),
    }


def inline(texto):
    """Convierte el Markdown inline básico a etiquetas de ReportLab."""
    texto = texto.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    codigos = []

    def guardar_codigo(m):
        codigos.append(m.group(1))
        return f"@@CODIGO{len(codigos) - 1}@@"

    texto = re.sub(r"`([^`]+)`", guardar_codigo, texto)
    texto = re.sub(
        r"\[([^\]]+)\]\(([^)]+)\)",
        r'<link href="\2" color="#0F172A">\1</link>',
        texto,
    )
    texto = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", texto)
    for i, codigo in enumerate(codigos):
        texto = texto.replace(
            f"@@CODIGO{i}@@",
            f'<font face="Courier" size="8" color="#0F172A">{codigo}</font>',
        )
    return texto


def texto_plano(texto):
    return re.sub(r"[*`]", "", texto).strip()


def es_separador_tabla(linea):
    celdas = [c.strip() for c in linea.strip().strip("|").split("|")]
    return bool(celdas) and all(re.fullmatch(r":?-{3,}:?", c) for c in celdas)


def preparar_markdown(ruta):
    lineas = ruta.read_text(encoding="utf-8").splitlines()
    idx_h1 = next((i for i, l in enumerate(lineas) if l.startswith("# ")), None)
    if idx_h1 is None:
        return "", "Control de Rondas - Meatex", "", lineas

    titulo = lineas[idx_h1][2:].strip()
    j = idx_h1 + 1
    while j < len(lineas) and not lineas[j].strip():
        j += 1

    subtitulo = "Control de Rondas - Meatex"
    revision = ""
    inicio_cuerpo = idx_h1 + 1

    if j < len(lineas) and lineas[j].startswith("## "):
        subtitulo = lineas[j][3:].strip()
        k = j + 1
        while k < len(lineas) and not lineas[k].strip():
            k += 1
        if k < len(lineas) and re.match(r"^Revisad[oa] el ", lineas[k]):
            revision = lineas[k].strip()
            inicio_cuerpo = k + 1
        else:
            inicio_cuerpo = j + 1
    else:
        for linea in lineas[idx_h1 + 1:]:
            if re.match(r"^Revisad[oa] el ", linea):
                revision = linea.strip()
                break

    return titulo, subtitulo, revision, lineas[inicio_cuerpo:]


class Documento(BaseDocTemplate):
    def __init__(self, ruta, titulo, **kwargs):
        super().__init__(str(ruta), pagesize=letter,
                         leftMargin=MARGEN, rightMargin=MARGEN,
                         topMargin=72, bottomMargin=72,
                         title=titulo, author="Control de Rondas - Meatex",
                         subject="Documentación del proyecto", **kwargs)

    def afterFlowable(self, flowable):
        if not isinstance(flowable, Paragraph):
            return
        nivel = {"H1": 0, "H2": 1}.get(flowable.style.name)
        if nivel is None:
            return
        texto = getattr(flowable, "_toc_text", flowable.getPlainText())
        self.notify("TOCEntry", (nivel, texto, self.page))


def marco():
    return Frame(MARGEN, 72, ANCHO_UTIL, ALTO_PAGINA - 144,
                 leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)


def pie(canvas, doc):
    canvas.saveState()
    canvas.setFont("Cuerpo", 8)
    canvas.setFillColor(COLOR_SUAVE)
    canvas.drawString(MARGEN, 26.9,
                      "Control de Rondas - Meatex | Documentación del proyecto")
    canvas.drawRightString(ANCHO_PAGINA - MARGEN, 26.9,
                           f"Página {canvas.getPageNumber()}")
    canvas.restoreState()


def portada(story, e, titulo, subtitulo, revision, descripcion, detalle):
    story.append(Spacer(1, 96))
    story.append(Paragraph("DOCUMENTACIÓN DEL PROYECTO", e["eyebrow"]))
    story.append(Spacer(1, 16))
    story.append(Paragraph(inline(titulo), e["title"]))
    story.append(Spacer(1, 6))
    story.append(Paragraph(inline(subtitulo), e["subtitle"]))
    story.append(Spacer(1, 24))
    if revision:
        story.append(Paragraph(inline(revision), e["revision"]))
        story.append(Spacer(1, 4))
    story.append(HRFlowable(width="100%", thickness=0.6, color=COLOR_BORDE,
                            spaceBefore=6, spaceAfter=0))
    story.append(Spacer(1, 12))
    story.append(Paragraph(inline(descripcion), e["lead"]))
    story.append(Spacer(1, 110))
    story.append(Paragraph(inline(detalle), e["small"]))


def bloque_codigo(codigo, e):
    interior = Preformatted(codigo, e["code"])
    tabla = Table([[interior]], colWidths=[ANCHO_UTIL])
    tabla.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), COLOR_FONDO),
        ("BOX", (0, 0), (-1, -1), 0.5, COLOR_BORDE),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return tabla


def tabla_markdown(filas, e):
    cabecera = [c.strip() for c in filas[0].strip().strip("|").split("|")]
    cuerpo = [[c.strip() for c in f.strip().strip("|").split("|")] for f in filas[1:]]
    n = len(cabecera)

    datos = [[Paragraph(inline(c), e["table_head"]) for c in cabecera]]
    for fila in cuerpo:
        fila = (fila + [""] * n)[:n]
        datos.append([Paragraph(inline(c), e["table_cell"]) for c in fila])

    if n == 2:
        pesos = [0.28, 0.72]
    elif n == 3:
        pesos = [0.20, 0.45, 0.35]
    else:
        pesos = [1 / n] * n

    tabla = LongTable(datos, colWidths=[ANCHO_UTIL * p for p in pesos],
                      repeatRows=1)
    tabla.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), COLOR_ENCABEZADO),
        ("GRID", (0, 0), (-1, -1), 0.4, COLOR_BORDE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#FAFBFC")]),
    ]))
    return tabla


def construir_story(lineas, e):
    story = []
    parrafo = []
    lista = []
    en_codigo = False
    codigo = []
    i = 0

    def cerrar_parrafo():
        if parrafo:
            story.append(Paragraph(inline(" ".join(parrafo)), e["body"]))
            parrafo.clear()

    def cerrar_lista():
        for tipo, texto, numero in lista:
            if tipo == "ul":
                story.append(Paragraph(inline(texto), e["bullet"], bulletText="•"))
            else:
                story.append(Paragraph(inline(texto), e["bullet"], bulletText=f"{numero}."))
        lista.clear()

    while i < len(lineas):
        linea = lineas[i]
        limpia = linea.strip()

        if limpia.startswith("```"):
            if en_codigo:
                cerrar_parrafo()
                cerrar_lista()
                story.append(bloque_codigo("\n".join(codigo), e))
                codigo.clear()
                en_codigo = False
            else:
                cerrar_parrafo()
                cerrar_lista()
                en_codigo = True
            i += 1
            continue

        if en_codigo:
            codigo.append(linea)
            i += 1
            continue

        if not limpia:
            cerrar_parrafo()
            cerrar_lista()
            i += 1
            continue

        if limpia.startswith("# "):
            cerrar_parrafo()
            cerrar_lista()
            texto = limpia[2:].strip()
            p = Paragraph(inline(texto), e["h1"])
            p._toc_text = texto_plano(texto)
            story.append(p)
            i += 1
            continue

        if limpia.startswith("# "):
            cerrar_parrafo()
            cerrar_lista()
            i += 1
            continue

        if limpia.startswith("## "):
            cerrar_parrafo()
            cerrar_lista()
            texto = limpia[3:].strip()
            p = Paragraph(inline(texto), e["h1"])
            p._toc_text = texto_plano(texto)
            story.append(p)
            i += 1
            continue

        if limpia.startswith("### "):
            cerrar_parrafo()
            cerrar_lista()
            texto = limpia[4:].strip()
            p = Paragraph(inline(texto), e["h2"])
            p._toc_text = texto_plano(texto)
            story.append(p)
            i += 1
            continue

        if limpia.startswith("#### "):
            cerrar_parrafo()
            cerrar_lista()
            story.append(Paragraph(inline(limpia[5:].strip()), e["h3"]))
            i += 1
            continue

        if limpia == "---":
            cerrar_parrafo()
            cerrar_lista()
            story.append(HRFlowable(width="100%", thickness=0.6,
                                    color=COLOR_BORDE, spaceBefore=6, spaceAfter=6))
            i += 1
            continue

        if limpia.startswith("|") and i + 1 < len(lineas) and es_separador_tabla(lineas[i + 1]):
            cerrar_parrafo()
            cerrar_lista()
            filas = [limpia]
            i += 2
            while i < len(lineas) and lineas[i].strip().startswith("|"):
                filas.append(lineas[i].strip())
                i += 1
            story.append(tabla_markdown(filas, e))
            story.append(Spacer(1, 6))
            continue

        if limpia.startswith("> "):
            cerrar_parrafo()
            cerrar_lista()
            story.append(Paragraph(inline(limpia[2:].strip()), e["quote"]))
            i += 1
            continue

        m = re.match(r"^[-*]\s+(.*)$", limpia)
        if m:
            cerrar_parrafo()
            lista.append(("ul", m.group(1), None))
            i += 1
            continue

        m = re.match(r"^(\d+)\.\s+(.*)$", limpia)
        if m:
            cerrar_parrafo()
            lista.append(("ol", m.group(2), m.group(1)))
            i += 1
            continue

        if lista and linea.startswith("  "):
            tipo, texto, numero = lista[-1]
            lista[-1] = (tipo, texto + " " + limpia, numero)
            i += 1
            continue

        cerrar_lista()
        parrafo.append(limpia)
        i += 1

    cerrar_parrafo()
    cerrar_lista()
    if en_codigo and codigo:
        story.append(bloque_codigo("\n".join(codigo), e))
    return story


def generar(documento, e):
    titulo, subtitulo, revision, lineas = preparar_markdown(documento["markdown"])
    documento["pdf"].parent.mkdir(parents=True, exist_ok=True)

    doc = Documento(documento["pdf"], titulo)
    doc.addPageTemplates([
        PageTemplate(id="portada", frames=[marco()]),
        PageTemplate(id="cuerpo", frames=[marco()], onPage=pie),
    ])

    story = []
    portada(story, e, titulo, subtitulo, revision,
            documento["descripcion"], documento["detalle"])
    story.append(NextPageTemplate("cuerpo"))
    story.append(PageBreak())

    toc = TableOfContents()
    toc.levelStyles = [e["toc1"], e["toc2"]]
    toc.dotsMinLevel = 0
    story.append(Paragraph("Contenido", e["toc_title"]))
    story.append(toc)
    story.append(PageBreak())

    story.extend(construir_story(lineas, e))
    doc.multiBuild(story)
    print(f"OK  {documento['pdf'].relative_to(RAIZ)}")


def main():
    registrar_fuentes()
    e = estilos()
    for documento in DOCUMENTOS:
        generar(documento, e)


if __name__ == "__main__":
    main()
