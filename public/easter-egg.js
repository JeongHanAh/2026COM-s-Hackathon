const escape = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

// Every letter keeps its place so the button does not move while the joke types.
export function commandLabel(label, command) {
  let delay = 220;
  const words = command.split(' ').map((word, index) => {
    if (index === 1) delay += 420;
    const letters = [...word].map(letter => {
      const start = delay;
      delay += index === 0 ? 90 : 65;
      return `<span class="command-char" style="--reveal-delay:${start}ms">${escape(letter)}</span>`;
    }).join('');
    delay += 35;
    return `<span class="command-word">${letters}</span>`;
  }).join(' ');
  return `<span class="command-label"><span class="command-base">${escape(label)}</span><span class="command-egg" aria-hidden="true">${words}</span></span>`;
}
