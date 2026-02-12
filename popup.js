class TextManager {
    constructor() {
        this.texts = [];
        this.selectedIndex = -1;
        this.editingIndex = -1;
        this.maxTexts = 20;
        this.init();
    }

    async init() {
        await this.loadTexts();
        this.setupEventListeners();
        this.setupKeyboardNavigation();
        this.renderTexts();
        this.updateEmptyState();
    }

    async exportTexts() {
        if (this.texts.length === 0) {
            alert('No texts to export!');
            return;
        }

        const data = JSON.stringify(this.texts, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'clipboard-backup.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    async importTexts(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const importedTexts = JSON.parse(e.target.result);
                if (!Array.isArray(importedTexts)) {
                    throw new Error('Invalid format: file must contain an array of strings');
                }

                // Append new texts
                let addedCount = 0;
                for (const text of importedTexts) {
                    if (typeof text === 'string' && text.trim().length > 0) {
                        if (this.texts.length < this.maxTexts) {
                            this.texts.push(text.trim());
                            addedCount++;
                        }
                    }
                }

                await this.saveTexts();
                this.renderTexts();
                this.updateEmptyState();

                // Reset file input
                event.target.value = '';

                if (addedCount > 0) {
                    alert(`Successfully imported ${addedCount} texts.`);
                } else if (this.texts.length >= this.maxTexts) {
                    alert(`Storage full! Maximum ${this.maxTexts} texts allowed. Some texts might not have been imported.`);
                } else {
                    alert('No valid texts found in file.');
                }

            } catch (error) {
                console.error('Import error:', error);
                alert('Error importing file: ' + error.message);
                event.target.value = ''; // Reset on error too
            }
        };
        reader.readAsText(file);
    }

    setupEventListeners() {
        document.getElementById('addTextBtn').addEventListener('click', () => {
            this.openModal();
        });

        // Export functionality
        document.getElementById('exportBtn').addEventListener('click', () => {
            this.exportTexts();
        });

        // Import functionality
        document.getElementById('importBtn').addEventListener('click', () => {
            document.getElementById('fileInput').click();
        });

        document.getElementById('fileInput').addEventListener('change', (e) => {
            this.importTexts(e);
        });

        // Search functionality
        document.getElementById('searchInput').addEventListener('input', (e) => {
            this.selectedIndex = -1; // Reset selection on search
            this.filterTexts(e.target.value);
        });

        // Modal functionality
        document.getElementById('closeModal').addEventListener('click', () => {
            this.closeModal();
        });

        document.getElementById('cancelBtn').addEventListener('click', () => {
            this.closeModal();
        });

        document.getElementById('saveTextBtn').addEventListener('click', () => {
            this.saveText();
        });

        // Close modal when clicking outside
        document.getElementById('textModal').addEventListener('click', (e) => {
            if (e.target.id === 'textModal') {
                this.closeModal();
            }
        });

        // Close modal with Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeModal();
            }
        });
    }

    setupKeyboardNavigation() {
        document.addEventListener('keydown', (e) => {
            // Ignore if modal is open
            if (document.getElementById('textModal').style.display === 'block') return;

            const visibleItems = Array.from(document.querySelectorAll('.text-item'))
                .filter(item => item.style.display !== 'none');

            if (visibleItems.length === 0) return;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.selectedIndex++;
                if (this.selectedIndex >= visibleItems.length) {
                    this.selectedIndex = 0; // Loop back to top
                }
                this.updateSelectionVisuals(visibleItems);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.selectedIndex--;
                if (this.selectedIndex < 0) {
                    this.selectedIndex = visibleItems.length - 1; // Loop to bottom
                }
                this.updateSelectionVisuals(visibleItems);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (this.selectedIndex >= 0 && this.selectedIndex < visibleItems.length) {
                    const selectedItem = visibleItems[this.selectedIndex];
                    const index = parseInt(selectedItem.dataset.index);
                    this.copyToClipboard(this.texts[index]);
                }
            }
        });
    }

    updateSelectionVisuals(visibleItems) {
        // Remove selected class from all items
        document.querySelectorAll('.text-item').forEach(item => {
            item.classList.remove('selected');
        });

        // Add selected class to current index
        if (this.selectedIndex >= 0 && this.selectedIndex < visibleItems.length) {
            const selectedItem = visibleItems[this.selectedIndex];
            selectedItem.classList.add('selected');
            selectedItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    async loadTexts() {
        try {
            const result = await chrome.storage.local.get(['savedTexts']);
            this.texts = result.savedTexts || [];
        } catch (error) {
            console.error('Error loading texts:', error);
            this.texts = [];
        }
    }

    async saveTexts() {
        try {
            await chrome.storage.local.set({ savedTexts: this.texts });
        } catch (error) {
            console.error('Error saving texts:', error);
        }
    }

    openModal(editIndex = -1) {
        this.editingIndex = editIndex;
        const modal = document.getElementById('textModal');
        const textInput = document.getElementById('textInput');
        const modalTitle = document.getElementById('modalTitle');

        if (editIndex >= 0) {
            modalTitle.textContent = 'Edit Text';
            textInput.value = this.texts[editIndex];
        } else {
            modalTitle.textContent = 'Add New Text';
            textInput.value = '';
        }

        modal.style.display = 'block';
        textInput.focus();
    }

    closeModal() {
        const modal = document.getElementById('textModal');
        modal.style.display = 'none';
        this.editingIndex = -1;
    }

    async saveText() {
        const textInput = document.getElementById('textInput');
        const text = textInput.value.trim();

        if (!text) {
            alert('Please enter some text');
            return;
        }

        if (this.editingIndex >= 0) {
            // Editing existing text
            this.texts[this.editingIndex] = text;
        } else {
            // Adding new text
            if (this.texts.length >= this.maxTexts) {
                alert(`Maximum ${this.maxTexts} texts allowed. Please delete some texts first.`);
                return;
            }
            this.texts.push(text);
        }

        await this.saveTexts();
        this.renderTexts();
        this.updateEmptyState();
        this.closeModal();
    }

    async deleteText(index) {
        if (confirm('Are you sure you want to delete this text?')) {
            this.texts.splice(index, 1);
            await this.saveTexts();
            this.renderTexts();
            this.updateEmptyState();
        }
    }

    async reorderTexts(fromIndex, toIndex) {
        // Remove the item from its current position
        const [movedItem] = this.texts.splice(fromIndex, 1);
        // Insert it at the new position
        this.texts.splice(toIndex, 0, movedItem);

        // Save the new order
        await this.saveTexts();
        // Re-render to update the UI
        this.renderTexts();
        this.selectedIndex = -1; // Reset selection after reorder
    }

    async copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
            this.showCopyNotification();
            setTimeout(() => window.close(), 100); // Close after a short delay to show notification
        } catch (error) {
            console.error('Error copying to clipboard:', error);
            // Fallback for older browsers
            this.fallbackCopyToClipboard(text);
        }
    }

    fallbackCopyToClipboard(text) {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();

        try {
            document.execCommand('copy');
            this.showCopyNotification();
            setTimeout(() => window.close(), 100); // Close after a short delay
        } catch (error) {
            console.error('Fallback copy failed:', error);
            alert('Failed to copy to clipboard');
        }

        document.body.removeChild(textArea);
    }

    showCopyNotification() {
        // Create a temporary notification
        const notification = document.createElement('div');
        notification.textContent = 'Copied to clipboard!';
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: #4caf50;
            color: white;
            padding: 12px 20px;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 500;
            z-index: 10000;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            animation: slideInRight 0.3s ease;
        `;

        // Add animation keyframes
        const style = document.createElement('style');
        style.textContent = `
            @keyframes slideInRight {
                from {
                    transform: translateX(100%);
                    opacity: 0;
                }
                to {
                    transform: translateX(0);
                    opacity: 1;
                }
            }
        `;
        document.head.appendChild(style);

        document.body.appendChild(notification);

        // Remove notification after 2 seconds
        setTimeout(() => {
            notification.style.animation = 'slideInRight 0.3s ease reverse';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
                if (style.parentNode) {
                    style.parentNode.removeChild(style);
                }
            }, 300);
        }, 2000);
    }

    filterTexts(searchTerm) {
        const textItems = document.querySelectorAll('.text-item');
        const term = searchTerm.toLowerCase();

        textItems.forEach(item => {
            const textContent = item.querySelector('.text-content').textContent.toLowerCase();
            if (textContent.includes(term)) {
                item.style.display = 'block';
            } else {
                item.style.display = 'none';
            }
        });
    }

    renderTexts() {
        const container = document.getElementById('textsContainer');
        container.innerHTML = '';

        this.texts.forEach((text, index) => {
            const textItem = document.createElement('div');
            textItem.className = 'text-item';
            textItem.draggable = true;
            textItem.dataset.index = index;
            textItem.innerHTML = `
                <div class="drag-handle" title="Drag to reorder">⋮⋮</div>
                <div class="text-content-wrapper">
                    <div class="text-content">${this.escapeHtml(text)}</div>
                    <div class="text-actions">
                        <button class="action-btn copy-btn" data-action="copy" data-index="${index}">
                            📋 Copy
                        </button>
                        <button class="action-btn edit-btn" data-action="edit" data-index="${index}">
                            ✏️ Edit
                        </button>
                        <button class="action-btn delete-btn" data-action="delete" data-index="${index}">
                            🗑️ Delete
                        </button>
                    </div>
                </div>
            `;

            // Add drag and drop handlers
            textItem.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', index);
                textItem.classList.add('dragging');
            });

            textItem.addEventListener('dragend', (e) => {
                textItem.classList.remove('dragging');
                // Remove all drag-over classes
                document.querySelectorAll('.text-item').forEach(item => {
                    item.classList.remove('drag-over');
                });
            });

            textItem.addEventListener('dragover', (e) => {
                e.preventDefault();
                textItem.classList.add('drag-over');
            });

            textItem.addEventListener('dragleave', (e) => {
                textItem.classList.remove('drag-over');
            });

            textItem.addEventListener('drop', (e) => {
                e.preventDefault();
                textItem.classList.remove('drag-over');

                const draggedIndex = parseInt(e.dataTransfer.getData('text/plain'));
                const targetIndex = parseInt(textItem.dataset.index);

                if (draggedIndex !== targetIndex) {
                    this.reorderTexts(draggedIndex, targetIndex);
                }
            });

            // Add click handlers
            textItem.addEventListener('click', (e) => {
                if (e.target.classList.contains('action-btn')) {
                    const action = e.target.dataset.action;
                    const index = parseInt(e.target.dataset.index);

                    switch (action) {
                        case 'copy':
                            this.copyToClipboard(text);
                            break;
                        case 'edit':
                            this.openModal(index);
                            break;
                        case 'delete':
                            this.deleteText(index);
                            break;
                    }
                } else if (!e.target.classList.contains('drag-handle')) {
                    // Click on text item itself - copy to clipboard (but not on drag handle)
                    this.copyToClipboard(text);
                }
            });

            container.appendChild(textItem);
        });
    }

    updateEmptyState() {
        const emptyState = document.getElementById('emptyState');
        const textsContainer = document.getElementById('textsContainer');

        if (this.texts.length === 0) {
            emptyState.style.display = 'block';
            textsContainer.style.display = 'none';
        } else {
            emptyState.style.display = 'none';
            textsContainer.style.display = 'block';
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize the text manager when the popup loads
document.addEventListener('DOMContentLoaded', () => {
    new TextManager();
});
