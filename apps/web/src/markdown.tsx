import { memo } from 'react'
import MarkdownIt from 'markdown-it'

// html:false 转义原始 HTML，防注入；linkify 自动识别链接；breaks 换行转 <br>
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div
      className={className ? `markdown-body ${className}` : 'markdown-body'}
      dangerouslySetInnerHTML={{ __html: md.render(text) }}
    />
  )
})

/** 文本首行（用于已完成 reasoning 的摘要预览）。 */
export function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? ''
  return line.trim()
}

/**
 * 流式场景下「最近完成的段落」的首行：按空行分段，取最后一个已有内容的
 * 段落的首行；段落随流式输出完成而前进。无内容段落（如末尾空行）跳过。
 */
export function latestCompletedParagraphFirstLine(text: string): string {
  const paragraphs = text.split(/\n\s*\n/)
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const first = (paragraphs[i]!.split('\n', 1)[0] ?? '').trim()
    if (first !== '') return first
  }
  return ''
}
