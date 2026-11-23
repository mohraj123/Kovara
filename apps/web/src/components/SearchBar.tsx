'use client';

import { useState } from 'react';

interface SearchBarProps {
  onSearch: (query: string) => void;
  onClear?: () => void;
  placeholder?: string;
}

export default function SearchBar({ onSearch, onClear, placeholder = "Search posts..." }: SearchBarProps) {
  const [query, setQuery] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      onSearch(query.trim());
    }
  };

  const handleClear = () => {
    setQuery('');
    onClear?.();
  };

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-md">
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          className="w-full px-4 py-2 pr-24 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {query.length > 0 && (
          <button
            type="button"
            onClick={handleClear}
            aria-label="Clear search"
            className="absolute right-12 top-1/2 transform -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-700"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="h-4 w-4">
              <path fillRule="evenodd" d="M5.293 5.293a1 1 0 011.414 0L9 11.586l2.293-2.293a1 1 0 111.414 1.414L10.414 13l2.293 2.293a1 1 0 01-1.414 1.414L9 14.414l-2.293 2.293a1 1 0 01-1.414-1.414L7.586 13l-2.293-2.293a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        )}
        <button
          type="submit"
          className="absolute right-2 top-1/2 transform -translate-y-1/2 px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
          disabled={!query.trim()}
        >
          Search
        </button>
      </div>
    </form>
  );
}
