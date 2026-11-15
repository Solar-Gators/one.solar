/**
 * Drag and drop for a kanban board, shared by the Sponsors board and Projects boards so both behave the same:
 * cards are `.kcard[data-card][draggable=true]` (or another selector, for lists that reorder the same way), columns' drop areas are `[data-drop="<key>"]`, the area under
 * the pointer gets `.is-over`, and the dragged card `.is-dragging`. Dragging is an extra: every board also has
 * a "move" menu on each card for phones and keyboards.
 *
 * onDrop(cardId, dropKey, beforeCardId | undefined): the card it was dropped above, if any.
 */
export function bindKanbanDnd(root, { onDrop, card: sel = '.kcard' }) {
  let dragging = null;
  root.addEventListener('dragstart', (e) => {
    const card = e.target.closest?.(`${sel}[draggable="true"]`);
    if (!card) return;
    dragging = card.dataset.card;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragging);
    card.classList.add('is-dragging');
  });
  root.addEventListener('dragend', () => {
    dragging = null;
    root.querySelectorAll('.is-dragging, .is-over').forEach((n) => n.classList.remove('is-dragging', 'is-over'));
  });
  root.addEventListener('dragover', (e) => {
    const zone = e.target.closest?.('[data-drop]');
    if (!zone || !dragging) return;
    e.preventDefault();
    root.querySelectorAll('.is-over').forEach((n) => n !== zone && n.classList.remove('is-over'));
    zone.classList.add('is-over');
  });
  root.addEventListener('drop', (e) => {
    const zone = e.target.closest?.('[data-drop]');
    if (!zone || !dragging) return;
    e.preventDefault();
    const after = [...zone.querySelectorAll(`${sel}:not(.is-dragging)`)].find((n) => e.clientY < n.getBoundingClientRect().top + n.offsetHeight / 2);
    onDrop(dragging, zone.dataset.drop, after?.dataset.card);
  });
}
