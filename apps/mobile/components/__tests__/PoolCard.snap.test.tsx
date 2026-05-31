import React from 'react';
import renderer from 'react-test-renderer';
import { PoolCard } from '../PoolCard';

describe('PoolCard Snapshots', () => {
  const defaultProps = {
    id: 'pool-456',
    name: 'Stellar Growth Pool',
    description: 'A diversified pool focused on high-growth Stellar ecosystem projects with sustainable returns.',
    totalValue: '$1,234,567',
    participants: 128,
    apy: '12.5%',
  };

  it('renders default state correctly', () => {
    const tree = renderer.create(<PoolCard {...defaultProps} />).toJSON();
    expect(tree).toMatchSnapshot();
  });

  it('renders loading state correctly', () => {
    const tree = renderer.create(<PoolCard {...defaultProps} isLoading={true} />).toJSON();
    expect(tree).toMatchSnapshot();
  });

  it('renders without APY correctly', () => {
    const { apy: _apy, ...propsWithoutApy } = defaultProps;
    const tree = renderer.create(<PoolCard {...propsWithoutApy} />).toJSON();
    expect(tree).toMatchSnapshot();
  });

  it('renders with zero participants correctly', () => {
    const tree = renderer.create(<PoolCard {...defaultProps} participants={0} />).toJSON();
    expect(tree).toMatchSnapshot();
  });

  it('renders with long description correctly', () => {
    const longDescription = 'This is a comprehensive investment pool that focuses on emerging technologies within the Stellar ecosystem, including DeFi protocols, NFT marketplaces, and cross-border payment solutions. The pool is managed by experienced professionals with a proven track record.';
    const tree = renderer.create(
      <PoolCard {...defaultProps} description={longDescription} />
    ).toJSON();
    expect(tree).toMatchSnapshot();
  });

  it('renders with onPress handler correctly', () => {
    const mockOnPress = jest.fn();
    const tree = renderer.create(
      <PoolCard {...defaultProps} onPress={mockOnPress} />
    ).toJSON();
    expect(tree).toMatchSnapshot();
  });
});